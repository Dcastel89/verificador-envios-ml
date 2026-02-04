// ============================================
// MÓDULO JUMPSELLER - Verificación Mayorista
// ============================================
// Este módulo maneja toda la integración con Jumpseller
// de forma independiente al código de MercadoLibre

var express = require('express');
var axios = require('axios');
var router = express.Router();

// Google Sheets - Mayoristas tiene su propio spreadsheet
var sheets = null;
// Spreadsheet exclusivo para mayoristas
var SHEET_ID = '1Z9L_9X0Z7UlFgRm65uIBFrGYkRmLy-OL2GTDqnFAi3M';

// Cache de tokens de Jumpseller
var jumpsellerAccounts = [];

// Cache de órdenes del día
var ordersCache = {
  data: [],
  lastUpdate: null
};

// ============================================
// CONFIGURACIÓN - Se llama desde server.js
// ============================================

function configure(sheetsClient, sheetIdIgnored) {
  sheets = sheetsClient;
  // Usamos nuestro propio SHEET_ID, no el de ML
  console.log('Jumpseller: Configurado con Google Sheets (ID: ' + SHEET_ID + ')');
}

// ============================================
// UTILIDADES DE FECHA (Argentina)
// ============================================

function getArgentinaTime() {
  var now = new Date();
  var argentinaOffset = -3 * 60;
  var localOffset = now.getTimezoneOffset();
  return new Date(now.getTime() + (localOffset + argentinaOffset) * 60000);
}

function getMayoristaDaySheetName(date) {
  var days = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
  var argDate = date ? new Date(date) : getArgentinaTime();
  return 'Mayorista_' + days[argDate.getDay()];
}

function getTodayMayoristaSheetName() {
  return getMayoristaDaySheetName();
}

function formatArgentinaTimestamp() {
  var argTime = getArgentinaTime();
  var day = String(argTime.getDate()).padStart(2, '0');
  var month = String(argTime.getMonth() + 1).padStart(2, '0');
  var year = argTime.getFullYear();
  var hours = String(argTime.getHours()).padStart(2, '0');
  var minutes = String(argTime.getMinutes()).padStart(2, '0');
  var seconds = String(argTime.getSeconds()).padStart(2, '0');
  return day + '/' + month + '/' + year + ' ' + hours + ':' + minutes + ':' + seconds;
}

// ============================================
// GOOGLE SHEETS - Tokens Jumpseller
// ============================================

async function loadJumpsellerTokens() {
  if (!sheets || !SHEET_ID) {
    console.log('Jumpseller: Sheets no configurado');
    return;
  }

  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'TokensJumpseller!A:C'
    });

    var rows = response.data.values || [];
    jumpsellerAccounts = [];

    // Fila 0 es header: Cuenta | Login | AuthToken
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0] || !row[1] || !row[2]) continue;

      jumpsellerAccounts.push({
        name: row[0].toString().trim(),
        login: row[1].toString().trim(),
        authToken: row[2].toString().trim()
      });
    }

    console.log('Jumpseller: Cargadas ' + jumpsellerAccounts.length + ' cuentas');
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      console.log('Jumpseller: Hoja TokensJumpseller no existe, creándola...');
      await createTokensJumpsellerSheet();
    } else {
      console.error('Jumpseller: Error cargando tokens:', error.message);
    }
  }
}

async function createTokensJumpsellerSheet() {
  if (!sheets || !SHEET_ID) return;

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          addSheet: {
            properties: { title: 'TokensJumpseller' }
          }
        }]
      }
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'TokensJumpseller!A1:C1',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [['Cuenta', 'Login', 'AuthToken']]
      }
    });

    console.log('Jumpseller: Hoja TokensJumpseller creada');
  } catch (error) {
    console.error('Jumpseller: Error creando hoja TokensJumpseller:', error.message);
  }
}

// ============================================
// GOOGLE SHEETS - Órdenes del día
// ============================================

async function ensureMayoristaSheetExists(sheetName) {
  if (!sheets || !SHEET_ID) return false;

  try {
    // Intentar leer la hoja
    await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A1'
    });
    return true;
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      // La hoja no existe, crearla
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          resource: {
            requests: [{
              addSheet: {
                properties: { title: sheetName }
              }
            }]
          }
        });

        // Header: Fecha | Hora | OrderID | Cuenta | Cliente | Items | Estado | HoraVerif | Metodo
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: sheetName + '!A1:I1',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [['Fecha', 'Hora', 'OrderID', 'Cuenta', 'Cliente', 'Items', 'Estado', 'HoraVerif', 'Metodo']]
          }
        });

        console.log('Jumpseller: Hoja ' + sheetName + ' creada');
        return true;
      } catch (createError) {
        console.error('Jumpseller: Error creando hoja ' + sheetName + ':', createError.message);
        return false;
      }
    }
    return false;
  }
}

async function clearMayoristaSheet(sheetName) {
  if (!sheets || !SHEET_ID) return false;

  try {
    // Primero asegurar que existe
    await ensureMayoristaSheetExists(sheetName);

    // Obtener el sheetId numérico
    var spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID
    });

    var targetSheet = spreadsheet.data.sheets.find(function(s) {
      return s.properties.title === sheetName;
    });

    if (!targetSheet) return false;

    var sheetId = targetSheet.properties.sheetId;

    // Borrar filas de datos (desde fila 2)
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          updateCells: {
            range: {
              sheetId: sheetId,
              startRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 9
            },
            fields: 'userEnteredValue'
          }
        }]
      }
    });

    console.log('Jumpseller: Hoja ' + sheetName + ' limpiada');
    return true;
  } catch (error) {
    console.error('Jumpseller: Error limpiando hoja:', error.message);
    return false;
  }
}

async function saveAllOrdersToSheet(sheetName, orders) {
  if (!sheets || !SHEET_ID) return 0;
  if (!orders || orders.length === 0) return 0;

  try {
    await ensureMayoristaSheetExists(sheetName);

    var argTime = getArgentinaTime();
    var fecha = argTime.toLocaleDateString('es-AR');
    var hora = argTime.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

    // Construir todas las filas de una vez
    var rows = orders.map(function(order) {
      // Formatear items como texto
      var itemsText = '';
      if (order.products && order.products.length > 0) {
        itemsText = order.products.map(function(p) {
          return p.qty + 'x ' + (p.sku || p.name || 'Sin SKU');
        }).join(', ');
      }

      return [
        fecha,
        hora,
        order.id.toString(),
        order.account || '',
        order.customer ? order.customer.fullname || '' : '',
        itemsText,
        'Pendiente',
        '', // HoraVerif
        ''  // Metodo
      ];
    });

    // Guardar todas las órdenes de una sola vez
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:I',
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows }
    });

    console.log('Jumpseller: ' + rows.length + ' órdenes guardadas en batch');
    return rows.length;
  } catch (error) {
    console.error('Jumpseller: Error guardando órdenes en batch:', error.message);
    return 0;
  }
}

async function getOrdersFromSheet(sheetName) {
  if (!sheets || !SHEET_ID) return [];

  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:I'
    });

    var rows = response.data.values || [];
    var orders = [];

    // Saltar header (fila 0)
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row[2]) continue; // Sin OrderID

      orders.push({
        rowIndex: i + 1,
        fecha: row[0] || '',
        hora: row[1] || '',
        orderId: row[2] || '',
        cuenta: row[3] || '',
        cliente: row[4] || '',
        items: row[5] || '',
        estado: row[6] || 'Pendiente',
        horaVerif: row[7] || '',
        metodo: row[8] || ''
      });
    }

    return orders;
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      // La hoja no existe, crearla
      await ensureMayoristaSheetExists(sheetName);
      return [];
    }
    console.error('Jumpseller: Error leyendo órdenes:', error.message);
    return [];
  }
}

async function markOrderVerified(sheetName, orderId, metodo) {
  if (!sheets || !SHEET_ID) return false;

  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:I'
    });

    var rows = response.data.values || [];
    var rowIndex = -1;

    for (var i = 1; i < rows.length; i++) {
      if (rows[i][2] && rows[i][2].toString() === orderId.toString()) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      console.log('Jumpseller: Orden ' + orderId + ' no encontrada en hoja');
      return false;
    }

    var horaVerif = getArgentinaTime().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Actualizar columnas G (Estado), H (HoraVerif), I (Metodo)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!G' + rowIndex + ':I' + rowIndex,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [['Verificado', horaVerif, metodo || 'manual']]
      }
    });

    console.log('Jumpseller: Orden ' + orderId + ' marcada como verificada');
    return true;
  } catch (error) {
    console.error('Jumpseller: Error marcando orden verificada:', error.message);
    return false;
  }
}

// ============================================
// GOOGLE SHEETS - Items de órdenes (verificación parcial)
// ============================================

var ITEMS_SHEET_NAME = 'Mayorista_Items';

async function ensureMayoristaItemsSheetExists() {
  if (!sheets || !SHEET_ID) return false;

  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: ITEMS_SHEET_NAME + '!A1'
    });
    return true;
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          resource: {
            requests: [{
              addSheet: {
                properties: { title: ITEMS_SHEET_NAME }
              }
            }]
          }
        });

        // Header: Fecha | OrderID | Cuenta | SKU | Nombre | Cantidad | Verificados | Metodo | UltimaVerif
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: ITEMS_SHEET_NAME + '!A1:I1',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [['Fecha', 'OrderID', 'Cuenta', 'SKU', 'Nombre', 'Cantidad', 'Verificados', 'Metodo', 'UltimaVerif']]
          }
        });

        console.log('Jumpseller: Hoja ' + ITEMS_SHEET_NAME + ' creada');
        return true;
      } catch (createError) {
        console.error('Jumpseller: Error creando hoja items:', createError.message);
        return false;
      }
    }
    return false;
  }
}

async function clearMayoristaItemsForDate(fecha) {
  if (!sheets || !SHEET_ID) return false;

  try {
    await ensureMayoristaItemsSheetExists();

    // Leer todos los datos
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: ITEMS_SHEET_NAME + '!A:I'
    });

    var rows = response.data.values || [];
    if (rows.length <= 1) return true; // Solo header

    // Encontrar filas que NO son de hoy (para mantenerlas)
    var rowsToKeep = [rows[0]]; // Mantener header
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] !== fecha) {
        rowsToKeep.push(rows[i]);
      }
    }

    // Obtener sheetId
    var spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    var targetSheet = spreadsheet.data.sheets.find(function(s) {
      return s.properties.title === ITEMS_SHEET_NAME;
    });
    if (!targetSheet) return false;

    // Limpiar toda la hoja y reescribir
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: ITEMS_SHEET_NAME + '!A:I'
    });

    if (rowsToKeep.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: ITEMS_SHEET_NAME + '!A1',
        valueInputOption: 'USER_ENTERED',
        resource: { values: rowsToKeep }
      });
    }

    return true;
  } catch (error) {
    console.error('Jumpseller: Error limpiando items del día:', error.message);
    return false;
  }
}

async function saveAllItemsToSheet(orders, fecha) {
  if (!sheets || !SHEET_ID) return 0;
  if (!orders || orders.length === 0) return 0;

  try {
    await ensureMayoristaItemsSheetExists();

    var rows = [];
    orders.forEach(function(order) {
      if (!order.products || order.products.length === 0) return;

      order.products.forEach(function(product) {
        rows.push([
          fecha,
          order.id.toString(),
          order.account || '',
          product.sku || '',
          product.name || '',
          product.qty || 1,
          0,  // Verificados (empieza en 0)
          '', // Metodo
          ''  // UltimaVerif
        ]);
      });
    });

    if (rows.length === 0) return 0;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: ITEMS_SHEET_NAME + '!A:I',
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows }
    });

    console.log('Jumpseller: ' + rows.length + ' items guardados');
    return rows.length;
  } catch (error) {
    console.error('Jumpseller: Error guardando items:', error.message);
    return 0;
  }
}

async function getOrderItemsFromSheet(orderId) {
  if (!sheets || !SHEET_ID) return [];

  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: ITEMS_SHEET_NAME + '!A:I'
    });

    var rows = response.data.values || [];
    var items = [];

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (row[1] && row[1].toString() === orderId.toString()) {
        items.push({
          rowIndex: i + 1,
          fecha: row[0] || '',
          orderId: row[1] || '',
          cuenta: row[2] || '',
          sku: row[3] || '',
          nombre: row[4] || '',
          cantidad: parseInt(row[5]) || 1,
          verificados: parseInt(row[6]) || 0,
          metodo: row[7] || '',
          ultimaVerif: row[8] || ''
        });
      }
    }

    return items;
  } catch (error) {
    console.error('Jumpseller: Error leyendo items:', error.message);
    return [];
  }
}

async function updateItemVerification(orderId, sku, verificados, metodo) {
  if (!sheets || !SHEET_ID) return false;

  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: ITEMS_SHEET_NAME + '!A:I'
    });

    var rows = response.data.values || [];
    var rowIndex = -1;

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (row[1] && row[1].toString() === orderId.toString() &&
          row[3] && row[3].toString() === sku.toString()) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      console.log('Jumpseller: Item no encontrado - orden ' + orderId + ', SKU ' + sku);
      return false;
    }

    var horaVerif = getArgentinaTime().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Actualizar columnas G (Verificados), H (Metodo), I (UltimaVerif)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: ITEMS_SHEET_NAME + '!G' + rowIndex + ':I' + rowIndex,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[verificados, metodo || 'manual', horaVerif]]
      }
    });

    // Verificar si la orden está completa
    await checkAndUpdateOrderStatus(orderId);

    return true;
  } catch (error) {
    console.error('Jumpseller: Error actualizando item:', error.message);
    return false;
  }
}

async function checkAndUpdateOrderStatus(orderId) {
  try {
    var items = await getOrderItemsFromSheet(orderId);
    if (items.length === 0) return;

    var todosVerificados = true;
    var metodoUsado = '';

    for (var i = 0; i < items.length; i++) {
      if (items[i].verificados < items[i].cantidad) {
        todosVerificados = false;
        break;
      }
      if (items[i].metodo) {
        metodoUsado = items[i].metodo;
      }
    }

    if (todosVerificados) {
      var sheetName = getTodayMayoristaSheetName();
      await markOrderVerified(sheetName, orderId, metodoUsado || 'mixed');
      console.log('Jumpseller: Orden ' + orderId + ' completada automáticamente');
    }
  } catch (error) {
    console.error('Jumpseller: Error verificando estado de orden:', error.message);
  }
}

// ============================================
// API DE JUMPSELLER
// ============================================

async function jumpsellerApiRequest(account, endpoint, method, data, extraParams) {
  var baseUrl = 'https://api.jumpseller.com/v1';
  var url = baseUrl + endpoint + '?login=' + account.login + '&authtoken=' + account.authToken;
  if (extraParams) {
    url += extraParams;
  }

  try {
    var config = {
      method: method || 'GET',
      url: url,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (data) {
      config.data = data;
    }

    var response = await axios(config);
    return response.data;
  } catch (error) {
    console.error('Jumpseller API error (' + account.name + '):', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data));
    }
    return null;
  }
}

async function getJumpsellerOrders(account, status) {
  // status puede ser: pending, paid, shipped, delivered, abandoned, canceled
  var endpoint = '/orders.json';

  // Agregar status como parámetro adicional (se concatena después de login y authtoken)
  var extraParams = '';
  if (status) {
    extraParams = '&status=' + status;
  }

  var result = await jumpsellerApiRequest(account, endpoint, 'GET', null, extraParams);

  if (result && Array.isArray(result)) {
    // Fecha límite: 2 semanas atrás
    var dosSemanasAtras = new Date();
    dosSemanasAtras.setDate(dosSemanasAtras.getDate() - 14);

    // Filtrar y agregar nombre de cuenta
    var orders = [];
    for (var i = 0; i < result.length; i++) {
      var orderWrapper = result[i];
      var order = orderWrapper.order || orderWrapper;

      // Solo incluir órdenes pagadas (la API no filtra bien)
      var orderStatus = (order.status || '').toLowerCase();
      if (orderStatus !== 'paid') {
        continue;
      }

      // Solo incluir órdenes sin despachar (unfulfilled)
      if (order.fulfillment_status && order.fulfillment_status !== 'unfulfilled') {
        continue;
      }

      // Solo incluir órdenes de las últimas 2 semanas
      if (order.created_at) {
        var orderDate = new Date(order.created_at);
        if (orderDate < dosSemanasAtras) {
          continue;
        }
      }

      order.account = account.name;
      orders.push(order);
    }

    console.log('Jumpseller: ' + account.name + ' - ' + result.length + ' totales, ' + orders.length + ' pagadas + sin despachar (últimas 2 sem)');
    return orders;
  }

  return [];
}

async function getJumpsellerOrderDetail(account, orderId) {
  var endpoint = '/orders/' + orderId + '.json';
  var result = await jumpsellerApiRequest(account, endpoint, 'GET');

  if (result) {
    var order = result.order || result;
    order.account = account.name;
    return order;
  }

  return null;
}

// ============================================
// SINCRONIZACIÓN
// ============================================

async function syncJumpsellerOrders() {
  console.log('Jumpseller: Iniciando sincronización...');

  if (jumpsellerAccounts.length === 0) {
    await loadJumpsellerTokens();
  }

  if (jumpsellerAccounts.length === 0) {
    console.log('Jumpseller: No hay cuentas configuradas');
    return { success: false, mensaje: 'No hay cuentas Jumpseller configuradas' };
  }

  var sheetName = getTodayMayoristaSheetName();
  var allOrders = [];
  var errors = [];

  // Obtener órdenes de todas las cuentas
  for (var i = 0; i < jumpsellerAccounts.length; i++) {
    var account = jumpsellerAccounts[i];
    console.log('Jumpseller: Obteniendo órdenes de ' + account.name);

    try {
      // Solo obtener órdenes "paid" (pagadas, pendientes de despacho)
      var paidOrders = await getJumpsellerOrders(account, 'paid');
      console.log('Jumpseller: ' + account.name + ' tiene ' + paidOrders.length + ' órdenes pagadas sin despachar');

      var accountOrders = paidOrders;

      allOrders = allOrders.concat(accountOrders);
    } catch (error) {
      console.error('Jumpseller: Error con cuenta ' + account.name + ':', error.message);
      errors.push(account.name + ': ' + error.message);
    }
  }

  // Limpiar hoja del día y guardar nuevas órdenes en batch
  await clearMayoristaSheet(sheetName);
  var saved = await saveAllOrdersToSheet(sheetName, allOrders);

  // Guardar items en hoja separada para verificación parcial
  var fecha = getArgentinaTime().toLocaleDateString('es-AR');
  await clearMayoristaItemsForDate(fecha);
  var itemsSaved = await saveAllItemsToSheet(allOrders, fecha);

  // Actualizar cache
  ordersCache.data = allOrders;
  ordersCache.lastUpdate = new Date();

  console.log('Jumpseller: Sincronización completada. ' + saved + ' órdenes, ' + itemsSaved + ' items guardados');

  return {
    success: true,
    total: allOrders.length,
    guardados: saved,
    items: itemsSaved,
    errores: errors
  };
}

// ============================================
// ENDPOINTS API
// ============================================

// GET /api/mayorista/orders - Lista de órdenes del día
router.get('/api/mayorista/orders', async function(req, res) {
  try {
    var sheetName = getTodayMayoristaSheetName();
    var orders = await getOrdersFromSheet(sheetName);

    // Calcular estadísticas
    var total = orders.length;
    var verificados = orders.filter(function(o) { return o.estado === 'Verificado'; }).length;
    var pendientes = total - verificados;

    res.json({
      success: true,
      fecha: getArgentinaTime().toLocaleDateString('es-AR'),
      hoja: sheetName,
      estadisticas: {
        total: total,
        verificados: verificados,
        pendientes: pendientes
      },
      orders: orders
    });
  } catch (error) {
    console.error('Jumpseller: Error en /api/mayorista/orders:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/mayorista/order/:id - Detalle de una orden
router.get('/api/mayorista/order/:id', async function(req, res) {
  try {
    var orderId = req.params.id;

    // Primero buscar en la hoja del día
    var sheetName = getTodayMayoristaSheetName();
    var orders = await getOrdersFromSheet(sheetName);
    var orderInSheet = orders.find(function(o) { return o.orderId === orderId; });

    if (!orderInSheet) {
      return res.status(404).json({ success: false, error: 'Orden no encontrada' });
    }

    // Buscar la cuenta correcta
    var account = jumpsellerAccounts.find(function(a) { return a.name === orderInSheet.cuenta; });

    if (!account) {
      // Si no encontramos la cuenta, devolver lo que tenemos de la hoja
      return res.json({
        success: true,
        order: {
          id: orderId,
          account: orderInSheet.cuenta,
          cliente: orderInSheet.cliente,
          items: orderInSheet.items,
          estado: orderInSheet.estado,
          horaVerif: orderInSheet.horaVerif,
          fromSheet: true
        }
      });
    }

    // Obtener detalle completo de Jumpseller
    var orderDetail = await getJumpsellerOrderDetail(account, orderId);

    if (orderDetail) {
      orderDetail.estadoLocal = orderInSheet.estado;
      orderDetail.horaVerif = orderInSheet.horaVerif;
      res.json({ success: true, order: orderDetail });
    } else {
      res.json({
        success: true,
        order: {
          id: orderId,
          account: orderInSheet.cuenta,
          cliente: orderInSheet.cliente,
          items: orderInSheet.items,
          estado: orderInSheet.estado,
          horaVerif: orderInSheet.horaVerif,
          fromSheet: true
        }
      });
    }
  } catch (error) {
    console.error('Jumpseller: Error en /api/mayorista/order/:id:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/mayorista/order/:id/verificado - Marcar orden como verificada
router.post('/api/mayorista/order/:id/verificado', async function(req, res) {
  try {
    var orderId = req.params.id;
    var metodo = req.body.metodo || 'manual';

    var sheetName = getTodayMayoristaSheetName();
    var result = await markOrderVerified(sheetName, orderId, metodo);

    if (result) {
      res.json({ success: true, mensaje: 'Orden marcada como verificada' });
    } else {
      res.status(404).json({ success: false, error: 'Orden no encontrada' });
    }
  } catch (error) {
    console.error('Jumpseller: Error marcando verificada:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/mayorista/order/:id/items - Obtener items de una orden con estado de verificación
router.get('/api/mayorista/order/:id/items', async function(req, res) {
  try {
    var orderId = req.params.id;
    var items = await getOrderItemsFromSheet(orderId);

    // Si no hay items en la hoja, intentar traerlos de Jumpseller
    if (items.length === 0) {
      var sheetName = getTodayMayoristaSheetName();
      var orders = await getOrdersFromSheet(sheetName);
      var orderInSheet = orders.find(function(o) { return o.orderId === orderId; });

      if (orderInSheet) {
        var account = jumpsellerAccounts.find(function(a) { return a.name === orderInSheet.cuenta; });
        if (account) {
          var orderDetail = await getJumpsellerOrderDetail(account, orderId);
          if (orderDetail && orderDetail.products) {
            items = orderDetail.products.map(function(p) {
              return {
                orderId: orderId,
                cuenta: orderInSheet.cuenta,
                sku: p.sku || '',
                nombre: p.name || '',
                cantidad: p.qty || 1,
                verificados: 0,
                metodo: '',
                fromApi: true
              };
            });
          }
        }
      }
    }

    res.json({ success: true, items: items });
  } catch (error) {
    console.error('Jumpseller: Error obteniendo items:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/mayorista/order/:id/item/verificar - Actualizar verificación de un item
router.post('/api/mayorista/order/:id/item/verificar', async function(req, res) {
  try {
    var orderId = req.params.id;
    var sku = req.body.sku;
    var verificados = req.body.verificados;
    var metodo = req.body.metodo || 'manual';

    if (!sku || verificados === undefined) {
      return res.status(400).json({ success: false, error: 'Faltan parámetros: sku, verificados' });
    }

    var result = await updateItemVerification(orderId, sku, verificados, metodo);

    if (result) {
      res.json({ success: true, mensaje: 'Item actualizado' });
    } else {
      res.status(404).json({ success: false, error: 'Item no encontrado' });
    }
  } catch (error) {
    console.error('Jumpseller: Error actualizando item:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/mayorista/sync - Sincronizar órdenes desde Jumpseller
router.get('/api/mayorista/sync', async function(req, res) {
  try {
    var result = await syncJumpsellerOrders();
    res.json(result);
  } catch (error) {
    console.error('Jumpseller: Error en sync:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/mayorista/accounts - Lista de cuentas configuradas
router.get('/api/mayorista/accounts', async function(req, res) {
  try {
    if (jumpsellerAccounts.length === 0) {
      await loadJumpsellerTokens();
    }

    var cuentas = jumpsellerAccounts.map(function(a) {
      return { name: a.name };
    });

    res.json({ success: true, cuentas: cuentas });
  } catch (error) {
    console.error('Jumpseller: Error obteniendo cuentas:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/mayorista/resumen - Resumen del día
router.get('/api/mayorista/resumen', async function(req, res) {
  try {
    var sheetName = getTodayMayoristaSheetName();
    var orders = await getOrdersFromSheet(sheetName);

    var total = orders.length;
    var verificados = orders.filter(function(o) { return o.estado === 'Verificado'; }).length;
    var pendientes = total - verificados;

    // Agrupar por cuenta
    var porCuenta = {};
    orders.forEach(function(o) {
      var cuenta = o.cuenta || 'Sin cuenta';
      if (!porCuenta[cuenta]) {
        porCuenta[cuenta] = { total: 0, verificados: 0, pendientes: 0 };
      }
      porCuenta[cuenta].total++;
      if (o.estado === 'Verificado') {
        porCuenta[cuenta].verificados++;
      } else {
        porCuenta[cuenta].pendientes++;
      }
    });

    // Lista de pendientes
    var listaPendientes = orders.filter(function(o) {
      return o.estado !== 'Verificado';
    }).map(function(o) {
      return {
        orderId: o.orderId,
        cuenta: o.cuenta,
        cliente: o.cliente,
        items: o.items
      };
    });

    res.json({
      success: true,
      fecha: getArgentinaTime().toLocaleDateString('es-AR'),
      estadisticas: {
        total: total,
        verificados: verificados,
        pendientes: pendientes
      },
      porCuenta: porCuenta,
      pendientes: listaPendientes
    });
  } catch (error) {
    console.error('Jumpseller: Error en resumen:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// EXPORTS
// ============================================

module.exports = router;
module.exports.configure = configure;
module.exports.loadJumpsellerTokens = loadJumpsellerTokens;
module.exports.syncJumpsellerOrders = syncJumpsellerOrders;
