require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Google Sheets setup
var sheets = null;
var SHEET_ID = process.env.GOOGLE_SHEET_ID;

if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  var auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  sheets = google.sheets({ version: 'v4', auth: auth });
}

// Cuentas de MercadoLibre - los tokens se actualizan desde Google Sheets
const accounts = [
  {
    name: 'TIENDA',
    clientId: process.env.TIENDA_CLIENT_ID,
    clientSecret: process.env.TIENDA_CLIENT_SECRET,
    accessToken: process.env.TIENDA_ACCESS_TOKEN,
    refreshToken: process.env.TIENDA_REFRESH_TOKEN
  },
  {
    name: 'SHOP',
    clientId: process.env.SHOP_CLIENT_ID,
    clientSecret: process.env.SHOP_CLIENT_SECRET,
    accessToken: process.env.SHOP_ACCESS_TOKEN,
    refreshToken: process.env.SHOP_REFRESH_TOKEN
  },
  {
    name: 'FURST',
    clientId: process.env.FURST_CLIENT_ID,
    clientSecret: process.env.FURST_CLIENT_SECRET,
    accessToken: process.env.FURST_ACCESS_TOKEN,
    refreshToken: process.env.FURST_REFRESH_TOKEN
  },
  {
    name: 'MUN1',
    clientId: process.env.MUN1_CLIENT_ID,
    clientSecret: process.env.MUN1_CLIENT_SECRET,
    accessToken: process.env.MUN1_ACCESS_TOKEN,
    refreshToken: process.env.MUN1_REFRESH_TOKEN
  },
  {
    name: 'MUN2',
    clientId: process.env.MUN2_CLIENT_ID,
    clientSecret: process.env.MUN2_CLIENT_SECRET,
    accessToken: process.env.MUN2_ACCESS_TOKEN,
    refreshToken: process.env.MUN2_REFRESH_TOKEN
  }
];

// ============================================
// MUTEX PARA PREVENIR DUPLICADOS
// ============================================

var sheetWriteLock = false;

async function acquireSheetLock(timeout = 5000) {
  var start = Date.now();
  while (sheetWriteLock) {
    if (Date.now() - start > timeout) {
      console.log('Timeout esperando lock de escritura');
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  sheetWriteLock = true;
  return true;
}

function releaseSheetLock() {
  sheetWriteLock = false;
}

// ============================================
// SISTEMA DE TOKENS CON GOOGLE SHEETS
// ============================================

async function loadTokensFromSheets() {
  if (!sheets || !SHEET_ID) {
    console.log('Sheets no configurado, usando tokens de variables de entorno');
    return;
  }

  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Tokens!A:D'
    });

    var rows = response.data.values || [];

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0]) continue;

      var accountName = row[0].toUpperCase();
      var accessToken = row[1];
      var refreshToken = row[2];

      var account = accounts.find(function(a) { return a.name === accountName; });
      if (account && accessToken) {
        account.accessToken = accessToken;
        if (refreshToken) account.refreshToken = refreshToken;
        console.log('Token cargado desde Sheets para ' + accountName);
      }
    }
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      console.log('Hoja Tokens no existe, creándola...');
      await createTokensSheet();
    } else {
      console.error('Error cargando tokens desde Sheets:', error.message);
    }
  }
}

async function createTokensSheet() {
  if (!sheets || !SHEET_ID) return;

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          addSheet: {
            properties: { title: 'Tokens' }
          }
        }]
      }
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Tokens!A1:D1',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [['Cuenta', 'AccessToken', 'RefreshToken', 'UltimaActualizacion']]
      }
    });

    var rows = accounts.map(function(a) {
      return [a.name, a.accessToken || '', a.refreshToken || '', new Date().toISOString()];
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Tokens!A2:D' + (accounts.length + 1),
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows }
    });

    console.log('Hoja Tokens creada exitosamente');
  } catch (error) {
    console.error('Error creando hoja Tokens:', error.message);
  }
}

// ============================================
// SISTEMA DE MAPEO SKU-BARCODE
// ============================================

var barcodeCache = {}; // Cache en memoria para mapeo barcode -> SKU

async function loadBarcodesFromSheets() {
  if (!sheets || !SHEET_ID) {
    console.log('Sheets no configurado, no se pueden cargar barcodes');
    return;
  }

  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Barcodes!A:C'
    });

    var rows = response.data.values || [];
    barcodeCache = {};

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0] || !row[1]) continue;

      var barcode = row[0].toString().trim();
      var sku = row[1].toString().trim();
      barcodeCache[barcode] = sku;
    }

    console.log('Cargados ' + Object.keys(barcodeCache).length + ' mapeos barcode-SKU');
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      console.log('Hoja Barcodes no existe, creándola...');
      await createBarcodesSheet();
    } else {
      console.error('Error cargando barcodes desde Sheets:', error.message);
    }
  }
}

async function createBarcodesSheet() {
  if (!sheets || !SHEET_ID) return;

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          addSheet: {
            properties: { title: 'Barcodes' }
          }
        }]
      }
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Barcodes!A1:C1',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [['Barcode', 'SKU', 'Descripcion']]
      }
    });

    console.log('Hoja Barcodes creada exitosamente');
  } catch (error) {
    console.error('Error creando hoja Barcodes:', error.message);
  }
}

async function saveBarcodeMapping(barcode, sku, description) {
  if (!sheets || !SHEET_ID) return false;

  try {
    // Actualizar cache local
    barcodeCache[barcode] = sku;

    // Buscar si ya existe este barcode
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Barcodes!A:C'
    });

    var rows = response.data.values || [];
    var rowIndex = -1;

    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] && rows[i][0].toString().trim() === barcode) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      // Agregar nuevo
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Barcodes!A:C',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[barcode, sku, description || '']]
        }
      });
    } else {
      // Actualizar existente
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Barcodes!A' + rowIndex + ':C' + rowIndex,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[barcode, sku, description || '']]
        }
      });
    }

    console.log('Mapeo guardado: ' + barcode + ' -> ' + sku);
    return true;
  } catch (error) {
    console.error('Error guardando mapeo barcode:', error.message);
    return false;
  }
}

function getSkuByBarcode(barcode) {
  return barcodeCache[barcode] || null;
}

// ============================================
// SISTEMA DE HORARIOS DE CORTE POR CUENTA/TIPO
// ============================================

// Cache: { "TIENDA|flex": 600, "TIENDA|colecta": 780, ... } (minutos desde medianoche)
var horariosCache = {};
var HORARIO_DEFAULT = 13 * 60; // 13:00 por defecto

// Mapeo de logistic_type a nombre amigable
function getTipoEnvio(logisticType) {
  if (logisticType === 'self_service') return 'flex';
  if (logisticType === 'drop_off' || logisticType === 'xd_drop_off') return 'despacho';
  if (logisticType === 'cross_docking') return 'colecta';
  return 'otro';
}

async function loadHorariosFromSheets() {
  if (!sheets || !SHEET_ID) {
    console.log('Sheets no configurado, usando horarios por defecto');
    return;
  }

  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Horarios!A:C'
    });

    var rows = response.data.values || [];
    horariosCache = {};

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0] || !row[1] || !row[2]) continue;

      var cuenta = row[0].toString().trim().toUpperCase();
      var tipo = row[1].toString().trim().toLowerCase();
      var hora = row[2].toString().trim();

      // Parsear hora (formato HH:MM)
      var parts = hora.split(':');
      if (parts.length === 2) {
        var minutos = parseInt(parts[0]) * 60 + parseInt(parts[1]);
        var key = cuenta + '|' + tipo;
        horariosCache[key] = minutos;
      }
    }

    console.log('Cargados ' + Object.keys(horariosCache).length + ' horarios de corte');
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      console.log('Hoja Horarios no existe, creándola...');
      await createHorariosSheet();
    } else {
      console.error('Error cargando horarios desde Sheets:', error.message);
    }
  }
}

async function createHorariosSheet() {
  if (!sheets || !SHEET_ID) return;

  try {
    // Crear la hoja
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          addSheet: {
            properties: { title: 'Horarios' }
          }
        }]
      }
    });

    // Agregar encabezados y datos por defecto
    var defaultData = [
      ['Cuenta', 'Tipo', 'HoraCorte'],
      ['TIENDA', 'flex', '10:00'],
      ['TIENDA', 'colecta', '13:00'],
      ['SHOP', 'flex', '10:00'],
      ['SHOP', 'despacho', '14:00'],
      ['FURST', 'flex', '10:00'],
      ['FURST', 'colecta', '13:00'],
      ['MUN1', 'flex', '10:00'],
      ['MUN1', 'despacho', '14:00'],
      ['MUN2', 'flex', '10:00'],
      ['MUN2', 'despacho', '14:00']
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Horarios!A1',
      valueInputOption: 'RAW',
      resource: { values: defaultData }
    });

    console.log('Hoja Horarios creada con valores por defecto');
    await loadHorariosFromSheets();
  } catch (error) {
    console.error('Error creando hoja Horarios:', error.message);
  }
}

function getHorarioCorte(cuenta, logisticType) {
  var tipo = getTipoEnvio(logisticType);
  var key = cuenta.toUpperCase() + '|' + tipo;

  if (horariosCache[key]) {
    return horariosCache[key];
  }

  // Buscar horario genérico para la cuenta (cualquier tipo)
  for (var k in horariosCache) {
    if (k.startsWith(cuenta.toUpperCase() + '|')) {
      return horariosCache[k];
    }
  }

  return HORARIO_DEFAULT;
}

async function saveTokenToSheets(accountName, accessToken, refreshToken) {
  if (!sheets || !SHEET_ID) return;

  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Tokens!A:D'
    });

    var rows = response.data.values || [];
    var rowIndex = -1;

    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] && rows[i][0].toUpperCase() === accountName.toUpperCase()) {
        rowIndex = i + 1;
        break;
      }
    }

    var now = new Date();
    var argentinaOffset = -3 * 60;
    var localOffset = now.getTimezoneOffset();
    var argentinaTime = new Date(now.getTime() + (localOffset + argentinaOffset) * 60000);
    var timestamp = argentinaTime.toLocaleString('es-AR');

    if (rowIndex === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Tokens!A:D',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[accountName, accessToken, refreshToken, timestamp]]
        }
      });
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Tokens!A' + rowIndex + ':D' + rowIndex,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[accountName, accessToken, refreshToken, timestamp]]
        }
      });
    }

    console.log('Token guardado en Sheets para ' + accountName);
  } catch (error) {
    console.error('Error guardando token en Sheets:', error.message);
  }
}

async function refreshAccessToken(account) {
  if (!account.refreshToken || !account.clientId || !account.clientSecret) {
    console.log('No se puede renovar token de ' + account.name + ': faltan credenciales');
    return false;
  }

  try {
    console.log('Renovando token para ' + account.name + '...');

    var response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
      params: {
        grant_type: 'refresh_token',
        client_id: account.clientId,
        client_secret: account.clientSecret,
        refresh_token: account.refreshToken
      },
      headers: {
        'accept': 'application/json',
        'content-type': 'application/x-www-form-urlencoded'
      }
    });

    account.accessToken = response.data.access_token;
    account.refreshToken = response.data.refresh_token;

    await saveTokenToSheets(account.name, account.accessToken, account.refreshToken);

    console.log('Token renovado exitosamente para ' + account.name);
    return true;
  } catch (error) {
    console.error('Error renovando token de ' + account.name + ':', error.response?.data || error.message);
    return false;
  }
}

// ============================================
// FUNCIONES CON AUTO-RENOVACIÓN
// ============================================

// Configuración de corte horario (13:00 = 780 minutos desde medianoche)
var CORTE_HORARIO = 13 * 60; // 13:00 en minutos

function getArgentinaTime() {
  var now = new Date();
  var argentinaOffset = -3 * 60;
  var localOffset = now.getTimezoneOffset();
  return new Date(now.getTime() + (localOffset + argentinaOffset) * 60000);
}

function getArgentinaDate(date) {
  var argentinaOffset = -3 * 60;
  var localOffset = date.getTimezoneOffset();
  return new Date(date.getTime() + (localOffset + argentinaOffset) * 60000);
}

function getDaySheetName(date) {
  var days = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
  var argDate = date ? getArgentinaDate(new Date(date)) : getArgentinaTime();
  return 'Envios_' + days[argDate.getDay()];
}

function getTodaySheetName() {
  return getDaySheetName();
}

function isWorkingHours() {
  var argentinaTime = getArgentinaTime();
  var day = argentinaTime.getDay();
  var hour = argentinaTime.getHours();
  var minute = argentinaTime.getMinutes();
  var timeInMinutes = hour * 60 + minute;

  if (day >= 1 && day <= 5 && timeInMinutes >= 510 && timeInMinutes < 1140) {
    return true;
  }
  return false;
}

function isBeforeCutoff(dateCreated, cuenta, logisticType) {
  // Verifica si la venta fue creada antes del corte horario
  var orderDate = getArgentinaDate(new Date(dateCreated));
  var timeInMinutes = orderDate.getHours() * 60 + orderDate.getMinutes();

  // Usar horario específico por cuenta y tipo, o el default
  var corte = cuenta && logisticType ? getHorarioCorte(cuenta, logisticType) : HORARIO_DEFAULT;

  return timeInMinutes < corte;
}

function getCorteMaximoDelDia() {
  // Devuelve el horario de corte más tardío del día (en minutos desde medianoche)
  // Este es el "cierre" del bloque del día
  var maxCorte = HORARIO_DEFAULT;

  var keys = Object.keys(horariosCache);
  for (var i = 0; i < keys.length; i++) {
    var corte = horariosCache[keys[i]];
    if (corte > maxCorte) {
      maxCorte = corte;
    }
  }

  return maxCorte;
}

function isYesterday(dateCreated) {
  // Verifica si la orden es de ayer
  var orderDate = getArgentinaDate(new Date(dateCreated));
  var today = getArgentinaTime();
  var yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  return orderDate.toLocaleDateString('es-AR') === yesterday.toLocaleDateString('es-AR');
}

function isTodayOrder(dateCreated) {
  // Verifica si la orden es de hoy (comparando solo la fecha)
  var orderDate = getArgentinaDate(new Date(dateCreated));
  var today = getArgentinaTime();
  return orderDate.toLocaleDateString('es-AR') === today.toLocaleDateString('es-AR');
}

function shouldProcessOrder(dateCreated, cuenta, logisticType) {
  // Bloque del día: incluye todas las órdenes de HOY (00:00 a 23:59)
  return isTodayOrder(dateCreated);
}

async function mlApiRequest(account, url, options = {}) {
  if (!account.accessToken) return null;

  var config = {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + account.accessToken,
      ...(options.headers || {})
    }
  };

  try {
    var response = await axios.get(url, config);
    return response.data;
  } catch (error) {
    if (error.response && (error.response.status === 401 || error.response.status === 403)) {
      console.log('Token expirado para ' + account.name + ', intentando renovar...');
      var renewed = await refreshAccessToken(account);

      if (renewed) {
        config.headers['Authorization'] = 'Bearer ' + account.accessToken;
        try {
          var retryResponse = await axios.get(url, config);
          return retryResponse.data;
        } catch (retryError) {
          console.error('Error después de renovar token:', retryError.message);
          return null;
        }
      }
    }
    return null;
  }
}

async function getReadyToShipOrders(account) {
  if (!account.accessToken) return [];

  // Primero obtener el user ID
  var userInfo = await mlApiRequest(account, 'https://api.mercadolibre.com/users/me');
  if (!userInfo || !userInfo.id) {
    console.log(account.name + ' - No se pudo obtener user ID');
    return [];
  }
  var sellerId = userInfo.id;
  console.log(account.name + ' - Seller ID: ' + sellerId);

  var allOrders = [];
  var offset = 0;
  var hasMore = true;

  // Buscar órdenes del vendedor (solo pagadas recientes)
  while (hasMore) {
    var data = await mlApiRequest(account, 'https://api.mercadolibre.com/orders/search', {
      params: {
        seller: sellerId,
        sort: 'date_desc',
        limit: 50,
        offset: offset
      }
    });

    if (!data || !data.results || data.results.length === 0) {
      hasMore = false;
      break;
    }

    console.log(account.name + ' - Órdenes encontradas: ' + data.results.length);
    allOrders = allOrders.concat(data.results);
    offset += 50;

    // Limitar a 200 órdenes para no sobrecargar
    if (offset >= 200) {
      hasMore = false;
    }
  }

  console.log(account.name + ' - Total órdenes: ' + allOrders.length);

  // Filtrar órdenes pagadas con shipping_id
  var ordersWithShipping = allOrders.filter(function(order) {
    return order.status === 'paid' && order.shipping && order.shipping.id;
  });

  console.log(account.name + ' - Órdenes con shipping: ' + ordersWithShipping.length);

  // Obtener detalles de cada envío
  var pendingShipments = [];

  for (var i = 0; i < ordersWithShipping.length; i++) {
    var order = ordersWithShipping[i];
    var shippingId = order.shipping.id;

    // Obtener detalles completos del envío
    var shipment = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/' + shippingId);

    if (!shipment) continue;

    // Log para debug (primeros 5)
    if (i < 5) {
      console.log(account.name + ' - Envío ' + shippingId + ': status=' + shipment.status + ', logistic_type=' + shipment.logistic_type + ', mode=' + shipment.mode);
    }

    // Filtrar por status pendiente
    var status = shipment.status;
    if (status !== 'ready_to_ship' && status !== 'pending' && status !== 'handling') {
      continue;
    }

    // Excluir fulfillment (FULL)
    if (shipment.logistic_type === 'fulfillment') {
      continue;
    }

    // Excluir acordar con comprador
    if (shipment.mode === 'not_specified' || shipment.mode === 'custom') {
      continue;
    }

    pendingShipments.push({
      id: shippingId.toString(),
      orderId: order.id.toString(),
      account: account.name,
      dateCreated: order.date_created,
      receiverName: shipment.receiver_address ? shipment.receiver_address.receiver_name : 'N/A',
      logisticType: shipment.logistic_type || '',
      status: status,
      mode: shipment.mode || ''
    });
  }

  console.log(account.name + ' - Envíos pendientes: ' + pendingShipments.length);

  // Eliminar duplicados por ID
  var seen = {};
  var unique = [];
  for (var i = 0; i < pendingShipments.length; i++) {
    var id = pendingShipments[i].id;
    if (!seen[id]) {
      seen[id] = true;
      unique.push(pendingShipments[i]);
    }
  }

  return unique;
}

// ============================================
// SISTEMA DE HOJAS ROTATIVAS (Lun-Vie)
// ============================================

async function ensureDaySheetExists(sheetName) {
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

        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: sheetName + '!A1:I1',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [['Fecha', 'Hora', 'Envio', 'Cuenta', 'Receptor', 'SKUs', 'Estado', 'HoraVerif', 'Metodo']]
          }
        });

        console.log('Hoja ' + sheetName + ' creada exitosamente');
        return true;
      } catch (createError) {
        console.error('Error creando hoja ' + sheetName + ':', createError.message);
        return false;
      }
    }
    return false;
  }
}

async function clearDaySheet(sheetName) {
  if (!sheets || !SHEET_ID) return;

  try {
    // Obtener el ID de la hoja
    var spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID
    });

    var sheet = spreadsheet.data.sheets.find(function(s) {
      return s.properties.title === sheetName;
    });

    if (!sheet) return;

    // Limpiar contenido (excepto encabezados)
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A2:H1000'
    });

    console.log('Hoja ' + sheetName + ' limpiada');
  } catch (error) {
    console.error('Error limpiando hoja:', error.message);
  }
}

async function getExistingShipmentIds(sheetName) {
  if (!sheets || !SHEET_ID) return [];
  sheetName = sheetName || getTodaySheetName();

  try {
    await ensureDaySheetExists(sheetName);

    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:C'
    });
    var rows = response.data.values || [];
    var ids = [];
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][2]) ids.push(rows[i][2].toString());
    }
    return ids;
  } catch (error) {
    console.error('Error leyendo sheet:', error.message);
    return [];
  }
}

async function addPendingShipments(shipments, sheetName) {
  if (!sheets || !SHEET_ID || shipments.length === 0) return;
  sheetName = sheetName || getTodaySheetName();

  // Adquirir lock para prevenir race conditions
  var lockAcquired = await acquireSheetLock();
  if (!lockAcquired) {
    console.log('No se pudo adquirir lock, reintentando más tarde');
    return;
  }

  try {
    await ensureDaySheetExists(sheetName);

    // Verificar duplicados DENTRO del lock para prevenir race conditions
    var existingIds = await getExistingShipmentIds(sheetName);
    var uniqueShipments = shipments.filter(function(s) {
      return existingIds.indexOf(s.id.toString()) === -1;
    });

    if (uniqueShipments.length === 0) {
      console.log('Todos los envios ya existen, nada que agregar');
      return;
    }

    var rows = uniqueShipments.map(function(s) {
      var argentinaDate = getArgentinaDate(new Date(s.dateCreated));
      var fecha = argentinaDate.toLocaleDateString('es-AR');
      var hora = argentinaDate.toLocaleTimeString('es-AR');

      return [fecha, hora, s.id, s.account, s.receiverName, '', 'Pendiente', ''];
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows }
    });

    console.log('Agregados ' + uniqueShipments.length + ' envios a ' + sheetName + ' (filtrados ' + (shipments.length - uniqueShipments.length) + ' duplicados)');
  } catch (error) {
    console.error('Error agregando envios:', error.message);
  } finally {
    releaseSheetLock();
  }
}

async function markAsVerified(shipmentId, items, verificacionDetalle) {
  if (!sheets || !SHEET_ID) return;

  var sheetName = getTodaySheetName();

  try {
    await ensureDaySheetExists(sheetName);

    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:I'
    });
    var rows = response.data.values || [];
    var rowIndex = -1;

    for (var i = 1; i < rows.length; i++) {
      if (rows[i][2] && rows[i][2].toString() === shipmentId.toString()) {
        rowIndex = i + 1;
        break;
      }
    }

    var argentinaTime = getArgentinaTime();
    var fecha = argentinaTime.toLocaleDateString('es-AR');
    var hora = argentinaTime.toLocaleTimeString('es-AR');
    var itemsStr = items.map(function(i) { return i.sku; }).join(', ');

    // Construir string de método de verificación
    var metodoStr = '';
    if (verificacionDetalle && verificacionDetalle.length > 0) {
      var totalScanned = 0;
      var totalManual = 0;
      verificacionDetalle.forEach(function(d) {
        totalScanned += d.scanned || 0;
        totalManual += d.manual || 0;
      });
      if (totalScanned > 0 && totalManual > 0) {
        metodoStr = 'Mixto (Esc:' + totalScanned + ' Man:' + totalManual + ')';
      } else if (totalScanned > 0) {
        metodoStr = 'Escaneado (' + totalScanned + ')';
      } else if (totalManual > 0) {
        metodoStr = 'Manual (' + totalManual + ')';
      }
    }

    if (rowIndex === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: sheetName + '!A:I',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[fecha, hora, shipmentId, '', '', itemsStr, 'Verificado', hora, metodoStr]] }
      });
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: sheetName + '!F' + rowIndex + ':I' + rowIndex,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[itemsStr, 'Verificado', hora, metodoStr]] }
      });
    }

    console.log('Envio ' + shipmentId + ' marcado como verificado en ' + sheetName + ' - Metodo: ' + metodoStr);
  } catch (error) {
    console.error('Error marcando verificado:', error.message);
  }
}

async function markAsDespachado(shipmentId, estadoML) {
  // Marca un envío como despachado (enviado sin escanear) en la hoja
  if (!sheets || !SHEET_ID) return;

  var sheetName = getTodaySheetName();

  try {
    await ensureDaySheetExists(sheetName);

    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:I'
    });
    var rows = response.data.values || [];
    var rowIndex = -1;

    for (var i = 1; i < rows.length; i++) {
      if (rows[i][2] && rows[i][2].toString() === shipmentId.toString()) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      console.log('Envio ' + shipmentId + ' no encontrado en ' + sheetName + ' para marcar despachado');
      return false;
    }

    var estadoActual = rows[rowIndex - 1][6] || '';

    // Solo marcar si no está ya verificado
    if (estadoActual === 'Verificado') {
      return false;
    }

    var argentinaTime = getArgentinaTime();
    var hora = argentinaTime.toLocaleTimeString('es-AR');

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!G' + rowIndex + ':I' + rowIndex,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[estadoML, hora, 'Sin escanear']] }
    });

    console.log('Envio ' + shipmentId + ' marcado como ' + estadoML + ' en ' + sheetName);
    return true;
  } catch (error) {
    console.error('Error marcando despachado:', error.message);
    return false;
  }
}

async function getShipmentStatus(account, shipmentId) {
  // Obtiene el estado actual de un envío desde ML
  if (!account.accessToken) return null;

  var url = 'https://api.mercadolibre.com/shipments/' + shipmentId;
  var data = await mlApiRequest(account, url);

  if (data && data.status) {
    return data.status;
  }
  return null;
}

// ============================================
// SINCRONIZACIÓN DE ENVÍOS
// ============================================

var lastMorningSyncDate = null;

async function syncMorningShipments() {
  // Sincronización completa de las 9:00 AM
  var today = getArgentinaTime().toLocaleDateString('es-AR');

  if (lastMorningSyncDate === today) {
    console.log('Sync matutino ya ejecutado hoy');
    return;
  }

  console.log('=== SINCRONIZACIÓN MATUTINA 9:00 AM ===');

  var sheetName = getTodaySheetName();

  // Limpiar la hoja del día (sobreescribir)
  await clearDaySheet(sheetName);
  await ensureDaySheetExists(sheetName);

  var allShipments = [];

  for (var i = 0; i < accounts.length; i++) {
    var shipments = await getReadyToShipOrders(accounts[i]);

    // Filtrar: solo los creados antes del corte horario de hoy o de días anteriores
    var filtered = shipments.filter(function(s) {
      return shouldProcessOrder(s.dateCreated, s.account, s.logisticType);
    });

    allShipments = allShipments.concat(filtered);
  }

  if (allShipments.length > 0) {
    await addPendingShipments(allShipments, sheetName);
  }

  lastMorningSyncDate = today;
  console.log('Sync matutino completado. Total: ' + allShipments.length + ' envios');
}

async function syncPendingShipments() {
  var argTime = getArgentinaTime();
  var day = argTime.getDay();
  var hour = argTime.getHours();
  var minute = argTime.getMinutes();
  var timeInMinutes = hour * 60 + minute;

  // Solo de lunes a viernes
  if (day < 1 || day > 5) {
    return;
  }

  // Sync matutino a las 9:00 (540 minutos)
  if (timeInMinutes >= 540 && timeInMinutes < 545) {
    await syncMorningShipments();
    return;
  }

  // No sincronizar fuera de horario laboral
  if (!isWorkingHours()) {
    return;
  }

  // Sync incremental durante el día
  console.log('Sincronizando envios pendientes...');

  var sheetName = getTodaySheetName();
  var existingIds = await getExistingShipmentIds(sheetName);
  var allShipments = [];

  for (var i = 0; i < accounts.length; i++) {
    var shipments = await getReadyToShipOrders(accounts[i]);

    // Filtrar por corte horario específico por cuenta/tipo
    var filtered = shipments.filter(function(s) {
      return shouldProcessOrder(s.dateCreated, s.account, s.logisticType);
    });

    allShipments = allShipments.concat(filtered);
  }

  var newShipments = allShipments.filter(function(s) {
    return existingIds.indexOf(s.id) === -1;
  });

  if (newShipments.length > 0) {
    await addPendingShipments(newShipments, sheetName);
  }

  console.log('Sync completado. Nuevos: ' + newShipments.length);
}

setInterval(syncPendingShipments, 60000);

function describeSKU(sku) {
  if (!sku) return '';

  if (sku.startsWith('SC')) {
    var colors = { 'A': 'Azul', 'V': 'Verde', 'R': 'Rosa', 'L': 'Lila', 'N': 'Negro' };
    var colorCode = sku.charAt(2);
    var color = colors[colorCode] || colorCode;
    var modelo = sku.substring(3);
    if (modelo.startsWith('i')) {
      return 'Funda Silicona ' + color + ' iPhone ' + modelo.substring(1);
    }
    return 'Funda Silicona ' + color + ' ' + modelo;
  }

  if (sku.startsWith('FT')) {
    var modelo = sku.substring(2);
    if (modelo.startsWith('i')) {
      return 'Funda Transparente iPhone ' + modelo.substring(1);
    }
    return 'Funda Transparente ' + modelo;
  }

  if (sku.startsWith('VF')) {
    var resto = sku.substring(2);
    if (resto.startsWith('i')) {
      return 'Vidrio iPhone ' + resto.substring(1);
    }
    return 'Vidrio ' + resto;
  }

  return sku;
}

function parseSKU(sku) {
  if (!sku) return [];
  var parts = sku.split('/');
  var components = [];
  var seen = {};
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (part.match(/^5[A-Z0-9]/)) continue;
    if (part === '') continue;
    if (seen[part]) continue;
    seen[part] = true;
    components.push(part);
  }
  return components;
}

async function findShipmentInAccount(account, shipmentId) {
  if (!account.accessToken) return null;

  var data = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/' + shipmentId);

  if (data) {
    return { account: account.name, shipment: data, token: account.accessToken };
  }
  return null;
}

async function getShipmentItems(token, shipmentId) {
  try {
    var response = await axios.get(
      'https://api.mercadolibre.com/shipments/' + shipmentId + '/items',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    return response.data;
  } catch (error) {
    return [];
  }
}

async function getItemWithVariations(token, itemId) {
  try {
    var response = await axios.get(
      'https://api.mercadolibre.com/items/' + itemId + '?include_attributes=all',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    return response.data;
  } catch (error) {
    return null;
  }
}

async function getUserProductSKU(token, userProductId) {
  if (!userProductId) return null;
  try {
    var response = await axios.get(
      'https://api.mercadolibre.com/user-products/' + userProductId,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    var data = response.data;
    if (data && data.attributes) {
      for (var i = 0; i < data.attributes.length; i++) {
        var attr = data.attributes[i];
        if (attr.id === 'SELLER_SKU' && attr.values && attr.values[0] && attr.values[0].name) {
          return attr.values[0].name;
        }
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

function findSKUInVariation(item, variationId) {
  if (!item || !item.variations) return null;
  for (var i = 0; i < item.variations.length; i++) {
    var variation = item.variations[i];
    if (variation.id === variationId) {
      if (variation.attributes) {
        for (var j = 0; j < variation.attributes.length; j++) {
          var attr = variation.attributes[j];
          if (attr.id === 'SELLER_SKU' && attr.value_name) {
            return attr.value_name;
          }
        }
      }
      if (variation.seller_custom_field) {
        return variation.seller_custom_field;
      }
    }
  }
  return null;
}

// ============================================
// ENDPOINTS
// ============================================

app.get('/api/debug/shipment/:shipmentId', async function(req, res) {
  var shipmentId = req.params.shipmentId;
  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    if (!account.accessToken) continue;

    var shipmentData = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/' + shipmentId);

    if (shipmentData) {
      var itemsData = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/' + shipmentId + '/items');
      return res.json({
        account: account.name,
        shipment: shipmentData,
        items: itemsData || []
      });
    }
  }
  res.status(404).json({ error: 'No encontrado' });
});

app.get('/api/shipment/:shipmentId', async function(req, res) {
  var shipmentId = req.params.shipmentId;
  var promises = accounts.map(function(account) {
    return findShipmentInAccount(account, shipmentId);
  });
  var results = await Promise.all(promises);
  var found = results.find(function(r) { return r !== null; });

  if (!found) {
    return res.status(404).json({ error: 'Envio no encontrado en ninguna cuenta' });
  }

  var token = found.token;
  var items = await getShipmentItems(token, shipmentId);
  var processedItems = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var sku = null;

    if (item.variation_id) {
      var itemData = await getItemWithVariations(token, item.item_id);
      sku = findSKUInVariation(itemData, item.variation_id);
    }

    if (!sku && item.user_product_id) {
      sku = await getUserProductSKU(token, item.user_product_id);
    }

    var components = parseSKU(sku);
    var title = item.description || 'Sin titulo';

    if (components.length > 1) {
      for (var j = 0; j < components.length; j++) {
        var component = components[j];
        processedItems.push({
          id: item.item_id + '-' + component,
          title: title,
          sku: component,
          description: describeSKU(component),
          quantity: item.quantity,
          isKit: true,
          originalSku: sku
        });
      }
    } else if (components.length === 1) {
      processedItems.push({
        id: item.item_id,
        title: title,
        sku: components[0],
        description: describeSKU(components[0]),
        quantity: item.quantity,
        isKit: false
      });
    } else {
      processedItems.push({
        id: item.item_id,
        title: title,
        sku: sku || 'SIN SKU',
        description: '',
        quantity: item.quantity,
        isKit: false
      });
    }
  }

  res.json({
    account: found.account,
    shipmentId: shipmentId,
    status: found.shipment.status,
    items: processedItems
  });
});

app.post('/api/shipment/:shipmentId/verificado', async function(req, res) {
  var shipmentId = req.params.shipmentId;
  var items = req.body.items || [];
  var verificacionDetalle = req.body.verificacionDetalle || [];

  await markAsVerified(shipmentId, items, verificacionDetalle);

  res.json({ success: true, message: 'Registro guardado' });
});

app.get('/api/sync', async function(req, res) {
  await syncPendingShipments();
  res.json({ success: true, message: 'Sincronizacion ejecutada' });
});

app.get('/api/auth/url/:accountName', function(req, res) {
  var accountName = req.params.accountName;
  var account = accounts.find(function(a) { return a.name === accountName.toUpperCase(); });
  if (!account) {
    return res.status(404).json({ error: 'Cuenta no encontrada' });
  }
  var redirectUri = process.env.REDIRECT_URI || 'https://verificador-envios-ml.onrender.com/auth/callback';
  var authUrl = 'https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=' + account.clientId + '&redirect_uri=' + encodeURIComponent(redirectUri);
  res.json({ url: authUrl, account: account.name });
});

app.get('/auth/callback', function(req, res) {
  var code = req.query.code;
  if (!code) {
    return res.send('Error: No se recibio codigo de autorizacion');
  }
  res.send('<html><body style="font-family: Arial; padding: 40px; text-align: center;"><h1>Codigo recibido</h1><code style="background: #f0f0f0; padding: 10px; display: block; margin: 20px;">' + code + '</code></body></html>');
});

app.post('/api/auth/token', async function(req, res) {
  var accountName = req.body.accountName;
  var code = req.body.code;
  var account = accounts.find(function(a) { return a.name === accountName.toUpperCase(); });
  if (!account) {
    return res.status(404).json({ error: 'Cuenta no encontrada' });
  }
  var redirectUri = process.env.REDIRECT_URI || 'https://verificador-envios-ml.onrender.com/auth/callback';
  try {
    var response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
      params: {
        grant_type: 'authorization_code',
        client_id: account.clientId,
        client_secret: account.clientSecret,
        code: code,
        redirect_uri: redirectUri
      },
      headers: { 'accept': 'application/json', 'content-type': 'application/x-www-form-urlencoded' }
    });

    account.accessToken = response.data.access_token;
    account.refreshToken = response.data.refresh_token;
    await saveTokenToSheets(account.name, account.accessToken, account.refreshToken);

    res.json({
      account: account.name,
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in,
      saved_to_sheets: true
    });
  } catch (error) {
    res.status(400).json({ error: 'Error al obtener token', details: error.response ? error.response.data : error.message });
  }
});

// Endpoint para sincronizar envíos manualmente
app.get('/api/sync-morning', async function(req, res) {
  try {
    // Resetear la fecha para permitir sync manual
    lastMorningSyncDate = null;
    await syncMorningShipments();
    var sheetName = getTodaySheetName();
    res.json({
      success: true,
      message: 'Sincronización completada',
      hoja: sheetName
    });
  } catch (error) {
    console.error('Error en sync manual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tokens/status', async function(req, res) {
  var status = [];

  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    var tokenStatus = {
      account: account.name,
      hasAccessToken: !!account.accessToken,
      hasRefreshToken: !!account.refreshToken,
      tokenPreview: account.accessToken ? account.accessToken.substring(0, 20) + '...' : 'N/A'
    };

    if (account.accessToken) {
      try {
        await axios.get('https://api.mercadolibre.com/users/me', {
          headers: { 'Authorization': 'Bearer ' + account.accessToken }
        });
        tokenStatus.valid = true;
      } catch (error) {
        tokenStatus.valid = false;
        tokenStatus.error = error.response?.status || error.message;
      }
    }

    status.push(tokenStatus);
  }

  res.json({ accounts: status });
});

app.post('/api/tokens/refresh/:accountName', async function(req, res) {
  var accountName = req.params.accountName;
  var account = accounts.find(function(a) { return a.name === accountName.toUpperCase(); });

  if (!account) {
    return res.status(404).json({ error: 'Cuenta no encontrada' });
  }

  var success = await refreshAccessToken(account);

  if (success) {
    res.json({
      success: true,
      message: 'Token renovado para ' + account.name,
      tokenPreview: account.accessToken.substring(0, 20) + '...'
    });
  } else {
    res.status(400).json({
      success: false,
      message: 'No se pudo renovar el token. Puede que necesites re-autorizar la cuenta.'
    });
  }
});

app.get('/api/status', function(req, res) {
  res.json({
    status: 'OK',
    message: 'Verificador de Envios ML',
    sheets: sheets ? 'conectado' : 'no configurado',
    workingHours: isWorkingHours(),
    todaySheet: getTodaySheetName(),
    accounts: accounts.map(function(a) {
      return { name: a.name, hasToken: !!a.accessToken };
    })
  });
});

// ============================================
// WEBHOOK DE MERCADOLIBRE
// ============================================

// Cache de seller IDs para webhook
var sellerIdCache = {};

app.post('/webhooks/ml', async function(req, res) {
  // Responder inmediatamente con 200 (requerido por ML)
  res.status(200).send('OK');

  var notification = req.body;
  console.log('Webhook ML recibido:', JSON.stringify(notification));

  try {
    // Verificar que sea una notificación de orders
    if (notification.topic !== 'orders_v2' && notification.topic !== 'orders') {
      console.log('Topic ignorado:', notification.topic);
      return;
    }

    var resource = notification.resource;
    var userId = notification.user_id;
    if (!resource) {
      console.log('Sin resource en notificación');
      return;
    }

    // Extraer order_id del resource (formato: /orders/123456789)
    var orderMatch = resource.match(/\/orders\/(\d+)/);
    if (!orderMatch) {
      console.log('No se pudo extraer order_id de:', resource);
      return;
    }

    var orderId = orderMatch[1];
    console.log('Procesando orden:', orderId, 'para user_id:', userId);

    // Buscar la cuenta correcta usando user_id
    var account = null;

    // Primero buscar en cache
    for (var name in sellerIdCache) {
      if (sellerIdCache[name] === userId) {
        account = accounts.find(function(a) { return a.name === name; });
        break;
      }
    }

    // Si no está en cache, buscar en todas las cuentas
    if (!account) {
      for (var i = 0; i < accounts.length; i++) {
        var acc = accounts[i];
        if (!acc.accessToken) continue;

        var userInfo = await mlApiRequest(acc, 'https://api.mercadolibre.com/users/me');
        if (userInfo && userInfo.id) {
          sellerIdCache[acc.name] = userInfo.id;
          if (userInfo.id === userId) {
            account = acc;
            console.log('Cuenta encontrada para user_id ' + userId + ': ' + acc.name);
            break;
          }
        }
      }
    }

    if (!account) {
      console.log('No se encontró cuenta para user_id:', userId);
      return;
    }

    // Obtener datos de la orden
    var orderData = await mlApiRequest(account, 'https://api.mercadolibre.com/orders/' + orderId);

    if (!orderData || !orderData.shipping || !orderData.shipping.id) {
      console.log('Orden sin shipping válido:', orderId);
      return;
    }

    var shipmentId = orderData.shipping.id.toString();
    var dateCreated = orderData.date_created;

    // Verificar si el envío ya existe en la hoja de hoy
    var sheetName = getTodaySheetName();
    var existingIds = await getExistingShipmentIds(sheetName);

    if (existingIds.indexOf(shipmentId) !== -1) {
      console.log('Envío ya existe en la hoja:', shipmentId);
      return;
    }

    // Obtener datos del envío
    var shipmentData = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/' + shipmentId);

    if (!shipmentData) {
      console.log('No se pudo obtener datos del envío:', shipmentId);
      return;
    }

    // Verificar corte horario (ahora que tenemos logistic_type)
    if (!shouldProcessOrder(dateCreated, account.name, shipmentData.logistic_type)) {
      var tipoEnvio = getTipoEnvio(shipmentData.logistic_type);
      console.log('Orden fuera de corte horario para ' + account.name + '/' + tipoEnvio + ', ignorando:', orderId);
      return;
    }

    // Verificar status
    if (shipmentData.status !== 'ready_to_ship' && shipmentData.status !== 'pending' && shipmentData.status !== 'handling') {
      console.log('Envío con status no pendiente:', shipmentId, shipmentData.status);
      return;
    }

    // Filtrar fulfillment
    if (shipmentData.logistic_type === 'fulfillment') {
      console.log('Envío fulfillment ignorado:', shipmentId);
      return;
    }

    // Filtrar acordar con comprador
    if (shipmentData.mode === 'not_specified' || shipmentData.mode === 'custom') {
      console.log('Envío acordar con comprador ignorado:', shipmentId);
      return;
    }

    var shipment = {
      id: shipmentId,
      account: account.name,
      dateCreated: dateCreated,
      receiverName: shipmentData.receiver_address ? shipmentData.receiver_address.receiver_name : 'N/A',
      logisticType: shipmentData.logistic_type
    };

    await addPendingShipments([shipment], sheetName);
    console.log('Nuevo envío agregado via webhook:', shipmentId, 'cuenta:', account.name);
  } catch (error) {
    console.error('Error procesando webhook:', error.message);
  }
});

// Endpoint para verificar que el webhook funciona
app.get('/webhooks/ml', function(req, res) {
  res.json({ status: 'Webhook endpoint activo', url: 'https://verificador-envios-ml.onrender.com/webhooks/ml' });
});

// ============================================
// ENDPOINTS DE BARCODE-SKU
// ============================================

// Obtener SKU por código de barras
app.get('/api/barcode/:barcode', function(req, res) {
  var barcode = req.params.barcode.trim();
  var sku = getSkuByBarcode(barcode);

  if (sku) {
    res.json({ barcode: barcode, sku: sku, found: true });
  } else {
    res.json({ barcode: barcode, sku: null, found: false });
  }
});

// Guardar mapeo barcode-SKU
app.post('/api/barcode', async function(req, res) {
  var barcode = req.body.barcode;
  var sku = req.body.sku;
  var description = req.body.description || '';

  if (!barcode || !sku) {
    return res.status(400).json({ error: 'Barcode y SKU son requeridos' });
  }

  var success = await saveBarcodeMapping(barcode.trim(), sku.trim(), description);

  if (success) {
    res.json({ success: true, message: 'Mapeo guardado', barcode: barcode, sku: sku });
  } else {
    res.status(500).json({ error: 'Error guardando mapeo' });
  }
});

// Obtener todos los mapeos
app.get('/api/barcodes', function(req, res) {
  var mappings = [];
  for (var barcode in barcodeCache) {
    mappings.push({ barcode: barcode, sku: barcodeCache[barcode] });
  }
  res.json({ mappings: mappings, count: mappings.length });
});

// Recargar mapeos desde Sheets
app.post('/api/barcodes/reload', async function(req, res) {
  await loadBarcodesFromSheets();
  res.json({ success: true, count: Object.keys(barcodeCache).length });
});

// Recargar horarios desde Sheets
app.post('/api/horarios/reload', async function(req, res) {
  await loadHorariosFromSheets();
  res.json({ success: true, horarios: horariosCache });
});

// Obtener horarios actuales
app.get('/api/horarios', function(req, res) {
  var horarios = [];
  for (var key in horariosCache) {
    var parts = key.split('|');
    var minutos = horariosCache[key];
    var horas = Math.floor(minutos / 60);
    var mins = minutos % 60;
    horarios.push({
      cuenta: parts[0],
      tipo: parts[1],
      hora: String(horas).padStart(2, '0') + ':' + String(mins).padStart(2, '0')
    });
  }
  res.json({ horarios: horarios, count: horarios.length });
});

// ============================================
// RESUMEN DEL DÍA
// ============================================

app.get('/api/resumen-dia', async function(req, res) {
  if (!sheets || !SHEET_ID) {
    return res.json({ error: 'Sheets no configurado', total: 0, verificados: 0, pendientes: 0 });
  }

  try {
    // Usar la hoja del día actual
    var sheetName = getTodaySheetName();
    var argentinaTime = getArgentinaTime();
    var hoy = argentinaTime.toLocaleDateString('es-AR');

    // Asegurar que la hoja existe
    await ensureDaySheetExists(sheetName);

    // Leer datos de la hoja del día
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:H'
    });

    var rows = response.data.values || [];
    var total = 0;
    var verificados = 0;
    var despachados = 0;
    var pendientes = [];

    // Estados que indican que el envío ya salió (sin escanear)
    var estadosDespachados = ['Despachado', 'Entregado', 'No entregado', 'Cancelado'];

    // Recorrer filas (saltando encabezado)
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.length < 3) continue;

      var envioId = row[2] || '';
      var cuenta = row[3] || '';
      var receptor = row[4] || '';
      var estado = row[6] || '';

      if (!envioId) continue;

      total++;
      if (estado === 'Verificado') {
        verificados++;
      } else if (estadosDespachados.indexOf(estado) !== -1) {
        // Despachado sin escanear
        despachados++;
      } else {
        // Pendiente real (ni verificado ni despachado)
        pendientes.push({
          id: envioId,
          cuenta: cuenta,
          receptor: receptor
        });
      }
    }

    res.json({
      fecha: hoy,
      hoja: sheetName,
      total: total,
      verificados: verificados,
      despachados: despachados,
      pendientesCount: pendientes.length,
      pendientes: pendientes,
      completo: pendientes.length === 0 && total > 0
    });
  } catch (error) {
    console.error('Error obteniendo resumen:', error.message);
    res.json({ error: error.message, total: 0, verificados: 0, pendientes: [] });
  }
});

// Endpoint para limpiar duplicados de la hoja del día
app.post('/api/limpiar-duplicados', async function(req, res) {
  if (!sheets || !SHEET_ID) {
    return res.json({ error: 'Sheets no configurado', eliminados: 0 });
  }

  var sheetName = getTodaySheetName();

  var lockAcquired = await acquireSheetLock(10000);
  if (!lockAcquired) {
    return res.json({ error: 'No se pudo adquirir lock', eliminados: 0 });
  }

  try {
    await ensureDaySheetExists(sheetName);

    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:I'
    });

    var rows = response.data.values || [];
    if (rows.length <= 1) {
      releaseSheetLock();
      return res.json({ mensaje: 'Hoja vacía', eliminados: 0 });
    }

    var header = rows[0];
    var seen = {};
    var uniqueRows = [header];
    var duplicados = 0;

    for (var i = 1; i < rows.length; i++) {
      var envioId = rows[i][2];
      if (!envioId) continue;

      if (!seen[envioId]) {
        seen[envioId] = true;
        uniqueRows.push(rows[i]);
      } else {
        duplicados++;
      }
    }

    if (duplicados === 0) {
      releaseSheetLock();
      return res.json({ mensaje: 'No hay duplicados', eliminados: 0 });
    }

    // Limpiar y reescribir la hoja sin duplicados
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:I'
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A1',
      valueInputOption: 'USER_ENTERED',
      resource: { values: uniqueRows }
    });

    console.log('Limpiados ' + duplicados + ' duplicados de ' + sheetName);
    res.json({
      mensaje: 'Duplicados eliminados',
      eliminados: duplicados,
      totalAntes: rows.length - 1,
      totalDespues: uniqueRows.length - 1
    });
  } catch (error) {
    console.error('Error limpiando duplicados:', error.message);
    res.json({ error: error.message, eliminados: 0 });
  } finally {
    releaseSheetLock();
  }
});

// ============================================
// AGREGAR ORDEN FALTANTE POR ID
// ============================================

// Endpoint para buscar una orden por ID y agregar el envío a la hoja del día
app.post('/api/agregar-orden/:orderId', async function(req, res) {
  var orderId = req.params.orderId;
  console.log('Buscando orden faltante:', orderId);

  var orderData = null;
  var accountFound = null;

  // Buscar la orden en todas las cuentas
  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    if (!account.accessToken) continue;

    var data = await mlApiRequest(account, 'https://api.mercadolibre.com/orders/' + orderId);

    if (data && data.id) {
      orderData = data;
      accountFound = account;
      console.log('Orden encontrada en cuenta:', account.name);
      break;
    }
  }

  if (!orderData) {
    return res.status(404).json({ error: 'Orden no encontrada en ninguna cuenta', orderId: orderId });
  }

  // Verificar que tenga shipping
  if (!orderData.shipping || !orderData.shipping.id) {
    return res.status(400).json({ error: 'La orden no tiene envío asociado', orderId: orderId });
  }

  var shipmentId = orderData.shipping.id.toString();

  // Verificar si ya existe en la hoja
  var sheetName = getTodaySheetName();
  var existingIds = await getExistingShipmentIds(sheetName);

  if (existingIds.indexOf(shipmentId) !== -1) {
    return res.json({
      mensaje: 'El envío ya existe en la hoja',
      orderId: orderId,
      shipmentId: shipmentId,
      cuenta: accountFound.name,
      yaExiste: true
    });
  }

  // Obtener datos del envío
  var shipmentData = await mlApiRequest(accountFound, 'https://api.mercadolibre.com/shipments/' + shipmentId);

  if (!shipmentData) {
    return res.status(400).json({ error: 'No se pudo obtener datos del envío', shipmentId: shipmentId });
  }

  // Crear el objeto de envío
  var shipment = {
    id: shipmentId,
    orderId: orderId,
    account: accountFound.name,
    dateCreated: orderData.date_created,
    receiverName: shipmentData.receiver_address ? shipmentData.receiver_address.receiver_name : 'N/A',
    logisticType: shipmentData.logistic_type || '',
    status: shipmentData.status,
    mode: shipmentData.mode || ''
  };

  // Agregar a la hoja (sin filtrar por corte horario)
  await addPendingShipments([shipment], sheetName);

  console.log('Orden agregada manualmente:', orderId, '-> Envío:', shipmentId);

  res.json({
    mensaje: 'Envío agregado exitosamente',
    orderId: orderId,
    shipmentId: shipmentId,
    cuenta: accountFound.name,
    receptor: shipment.receiverName,
    estado: shipmentData.status,
    logisticType: shipmentData.logistic_type,
    hoja: sheetName
  });
});

// Endpoint GET para ver información de una orden sin agregarla
app.get('/api/orden/:orderId', async function(req, res) {
  var orderId = req.params.orderId;

  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    if (!account.accessToken) continue;

    var data = await mlApiRequest(account, 'https://api.mercadolibre.com/orders/' + orderId);

    if (data && data.id) {
      var shipmentData = null;
      if (data.shipping && data.shipping.id) {
        shipmentData = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/' + data.shipping.id);
      }

      return res.json({
        cuenta: account.name,
        orderId: data.id,
        status: data.status,
        dateCreated: data.date_created,
        shipmentId: data.shipping ? data.shipping.id : null,
        shipment: shipmentData ? {
          status: shipmentData.status,
          logisticType: shipmentData.logistic_type,
          mode: shipmentData.mode,
          receiverName: shipmentData.receiver_address ? shipmentData.receiver_address.receiver_name : 'N/A'
        } : null
      });
    }
  }

  res.status(404).json({ error: 'Orden no encontrada', orderId: orderId });
});

// Endpoint para actualizar estados de envíos desde ML
// Consulta la API de ML y marca como despachados los que ya salieron
app.post('/api/actualizar-estados', async function(req, res) {
  if (!sheets || !SHEET_ID) {
    return res.json({ error: 'Sheets no configurado', actualizados: 0 });
  }

  var sheetName = getTodaySheetName();

  try {
    await ensureDaySheetExists(sheetName);

    // Leer todos los envíos de la hoja
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:I'
    });

    var rows = response.data.values || [];
    var actualizados = 0;
    var errores = 0;

    // Procesar cada envío que no esté verificado
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row[2]) continue;

      var envioId = row[2];
      var cuenta = row[3] || '';
      var estadoActual = row[6] || '';

      // Solo procesar si no está ya verificado o marcado
      if (estadoActual === 'Verificado' || estadoActual === 'Despachado' || estadoActual === 'Entregado') {
        continue;
      }

      // Encontrar la cuenta correspondiente
      var account = accounts.find(function(a) {
        return a.name.toUpperCase() === cuenta.toUpperCase();
      });

      if (!account || !account.accessToken) {
        continue;
      }

      // Consultar estado en ML
      var estadoML = await getShipmentStatus(account, envioId);

      if (estadoML && estadoML !== 'ready_to_ship') {
        // Mapear estados de ML a texto legible
        var estadoTexto = 'Despachado';
        if (estadoML === 'shipped') {
          estadoTexto = 'Despachado';
        } else if (estadoML === 'delivered') {
          estadoTexto = 'Entregado';
        } else if (estadoML === 'not_delivered') {
          estadoTexto = 'No entregado';
        } else if (estadoML === 'cancelled') {
          estadoTexto = 'Cancelado';
        }

        var marcado = await markAsDespachado(envioId, estadoTexto);
        if (marcado) {
          actualizados++;
        }
      }

      // Pequeña pausa para no saturar la API
      await new Promise(function(resolve) { setTimeout(resolve, 100); });
    }

    console.log('Estados actualizados: ' + actualizados + ', Errores: ' + errores);
    res.json({
      mensaje: 'Estados actualizados',
      actualizados: actualizados,
      errores: errores
    });
  } catch (error) {
    console.error('Error actualizando estados:', error.message);
    res.json({ error: error.message, actualizados: 0 });
  }
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// INICIO DEL SERVIDOR
// ============================================

var PORT = process.env.PORT || 3000;

async function initializeServer() {
  try {
    await loadTokensFromSheets();
    await loadBarcodesFromSheets();
    await loadHorariosFromSheets();
    console.log('Datos cargados desde Sheets');
  } catch (error) {
    console.error('Error cargando datos:', error.message);
  }

  app.listen(PORT, function() {
    console.log('Servidor corriendo en puerto ' + PORT);
    setTimeout(syncPendingShipments, 5000);
  });
}

initializeServer();
