require('dotenv').config();
var express = require('express');
var cors = require('cors');
var axios = require('axios');
var path = require('path');
var { google } = require('googleapis');

var app = express();
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

var accounts = [
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
  }
];

// ==================== GESTION DE TOKENS ====================

// Crear hoja "Tokens" si no existe
async function createTokensSheet() {
  if (!sheets || !SHEET_ID) return false;
  try {
    // Obtener lista de hojas existentes
    var spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID
    });

    var tokensSheetExists = spreadsheet.data.sheets.some(function(sheet) {
      return sheet.properties.title === 'Tokens';
    });

    if (!tokensSheetExists) {
      // Crear la hoja "Tokens"
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: {
          requests: [{
            addSheet: {
              properties: {
                title: 'Tokens'
              }
            }
          }]
        }
      });

      // Agregar encabezados
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Tokens!A1:D1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['Cuenta', 'AccessToken', 'RefreshToken', 'UltimaActualizacion']]
        }
      });

      console.log('Hoja "Tokens" creada exitosamente');
    }
    return true;
  } catch (error) {
    console.error('Error creando hoja Tokens:', error.message);
    return false;
  }
}

// Cargar tokens desde Google Sheets al iniciar
async function loadTokensFromSheets() {
  if (!sheets || !SHEET_ID) {
    console.log('Google Sheets no configurado, usando tokens de variables de entorno');
    return;
  }

  try {
    // Asegurar que la hoja existe
    await createTokensSheet();

    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Tokens!A:D'
    });

    var rows = response.data.values || [];

    // Saltar encabezado
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0]) continue;

      var accountName = row[0].toUpperCase();
      var accessToken = row[1] || '';
      var refreshToken = row[2] || '';

      // Buscar cuenta y actualizar tokens
      for (var j = 0; j < accounts.length; j++) {
        if (accounts[j].name === accountName) {
          if (accessToken) {
            accounts[j].accessToken = accessToken;
          }
          if (refreshToken) {
            accounts[j].refreshToken = refreshToken;
          }
          console.log('Tokens cargados para cuenta ' + accountName + ' desde Sheets');
          break;
        }
      }
    }

    console.log('Carga de tokens desde Sheets completada');
  } catch (error) {
    console.error('Error cargando tokens desde Sheets:', error.message);
  }
}

// Guardar token en Google Sheets
async function saveTokenToSheets(accountName, accessToken, refreshToken) {
  if (!sheets || !SHEET_ID) return false;

  try {
    // Asegurar que la hoja existe
    await createTokensSheet();

    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Tokens!A:D'
    });

    var rows = response.data.values || [];
    var rowIndex = -1;

    // Buscar fila existente para la cuenta
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] && rows[i][0].toUpperCase() === accountName.toUpperCase()) {
        rowIndex = i + 1; // +1 porque Sheets es 1-indexed
        break;
      }
    }

    var now = new Date();
    var argentinaOffset = -3 * 60;
    var localOffset = now.getTimezoneOffset();
    var argentinaTime = new Date(now.getTime() + (localOffset + argentinaOffset) * 60000);
    var timestamp = argentinaTime.toLocaleString('es-AR');

    var rowData = [accountName.toUpperCase(), accessToken, refreshToken, timestamp];

    if (rowIndex === -1) {
      // Agregar nueva fila
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Tokens!A:D',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [rowData] }
      });
    } else {
      // Actualizar fila existente
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Tokens!A' + rowIndex + ':D' + rowIndex,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [rowData] }
      });
    }

    console.log('Token guardado en Sheets para cuenta ' + accountName);
    return true;
  } catch (error) {
    console.error('Error guardando token en Sheets:', error.message);
    return false;
  }
}

// Renovar access token usando refresh token
async function refreshAccessToken(account) {
  if (!account.refreshToken || !account.clientId || !account.clientSecret) {
    console.error('Faltan credenciales para renovar token de ' + account.name);
    return false;
  }

  try {
    console.log('Renovando token para cuenta ' + account.name + '...');

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

    var newAccessToken = response.data.access_token;
    var newRefreshToken = response.data.refresh_token;

    // Actualizar en memoria
    account.accessToken = newAccessToken;
    if (newRefreshToken) {
      account.refreshToken = newRefreshToken;
    }

    // Guardar en Sheets
    await saveTokenToSheets(account.name, newAccessToken, account.refreshToken);

    console.log('Token renovado exitosamente para ' + account.name);
    return true;
  } catch (error) {
    console.error('Error renovando token de ' + account.name + ':', error.response ? error.response.data : error.message);
    return false;
  }
}

// Request a ML API con auto-renovacion de token
async function mlApiRequest(account, url, options) {
  if (!account.accessToken) {
    throw new Error('No hay access token para ' + account.name);
  }

  options = options || {};
  options.headers = options.headers || {};
  options.headers['Authorization'] = 'Bearer ' + account.accessToken;

  try {
    var response = await axios.get(url, options);
    return response;
  } catch (error) {
    // Si es error 401 o 403, intentar renovar token y reintentar
    if (error.response && (error.response.status === 401 || error.response.status === 403)) {
      console.log('Token expirado para ' + account.name + ', intentando renovar...');

      var renewed = await refreshAccessToken(account);
      if (renewed) {
        // Reintentar con nuevo token
        options.headers['Authorization'] = 'Bearer ' + account.accessToken;
        return await axios.get(url, options);
      }
    }

    throw error;
  }
}

// ==================== FIN GESTION DE TOKENS ====================

// Verificar si estamos en horario laboral (Lun-Vie 8:30-19:00 Argentina)
function isWorkingHours() {
  var now = new Date();
  var argentinaOffset = -3 * 60;
  var localOffset = now.getTimezoneOffset();
  var argentinaTime = new Date(now.getTime() + (localOffset + argentinaOffset) * 60000);

  var day = argentinaTime.getDay();
  var hour = argentinaTime.getHours();
  var minute = argentinaTime.getMinutes();
  var timeInMinutes = hour * 60 + minute;

  // Lunes (1) a Viernes (5), 8:30 (510) a 19:00 (1140)
  if (day >= 1 && day <= 5 && timeInMinutes >= 510 && timeInMinutes < 1140) {
    return true;
  }
  return false;
}

// Obtener envios ready_to_ship de una cuenta
async function getReadyToShipOrders(account) {
  if (!account.accessToken) return [];
  try {
    var response = await mlApiRequest(
      account,
      'https://api.mercadolibre.com/shipments/search',
      {
        params: {
          seller_id: 'me',
          status: 'ready_to_ship',
          limit: 50
        }
      }
    );

    var shipments = response.data.results || [];

    // Filtrar: excluir fulfillment (FULL) y self_service sin carrier (acordar)
    var filtered = shipments.filter(function(s) {
      if (s.logistic_type === 'fulfillment') return false;
      if (s.logistic_type === 'self_service' && !s.tracking_method) return false;
      return true;
    });

    return filtered.map(function(s) {
      return {
        id: s.id.toString(),
        account: account.name,
        dateCreated: s.date_created,
        receiverName: s.receiver_address ? s.receiver_address.receiver_name : 'N/A',
        logisticType: s.logistic_type
      };
    });
  } catch (error) {
    console.error('Error obteniendo envios de ' + account.name + ':', error.message);
    return [];
  }
}

// Obtener envios existentes en la hoja
async function getExistingShipmentIds() {
  if (!sheets || !SHEET_ID) return [];
  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'A:C'
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

// Agregar envios pendientes a la hoja
async function addPendingShipments(shipments) {
  if (!sheets || !SHEET_ID || shipments.length === 0) return;
  try {
    var rows = shipments.map(function(s) {
      var date = new Date(s.dateCreated);
      var argentinaOffset = -3 * 60;
      var localOffset = date.getTimezoneOffset();
      var argentinaDate = new Date(date.getTime() + (localOffset + argentinaOffset) * 60000);

      var fecha = argentinaDate.toLocaleDateString('es-AR');
      var hora = argentinaDate.toLocaleTimeString('es-AR');

      return [fecha, hora, s.id, s.account, s.receiverName, '', 'Pendiente', ''];
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'A:H',
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows }
    });

    console.log('Agregados ' + shipments.length + ' envios pendientes');
  } catch (error) {
    console.error('Error agregando envios:', error.message);
  }
}

// Marcar envio como verificado
async function markAsVerified(shipmentId, items) {
  if (!sheets || !SHEET_ID) return;
  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'A:H'
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
      // Si no existe, agregar nueva fila
      var now = new Date();
      var argentinaOffset = -3 * 60;
      var localOffset = now.getTimezoneOffset();
      var argentinaTime = new Date(now.getTime() + (localOffset + argentinaOffset) * 60000);
      var fecha = argentinaTime.toLocaleDateString('es-AR');
      var hora = argentinaTime.toLocaleTimeString('es-AR');
      var itemsStr = items.map(function(i) { return i.sku; }).join(', ');

      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'A:H',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[fecha, hora, shipmentId, '', '', itemsStr, 'Verificado', hora]] }
      });
    } else {
      // Actualizar fila existente
      var now = new Date();
      var argentinaOffset = -3 * 60;
      var localOffset = now.getTimezoneOffset();
      var argentinaTime = new Date(now.getTime() + (localOffset + argentinaOffset) * 60000);
      var horaVerif = argentinaTime.toLocaleTimeString('es-AR');
      var itemsStr = items.map(function(i) { return i.sku; }).join(', ');

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'F' + rowIndex + ':H' + rowIndex,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[itemsStr, 'Verificado', horaVerif]] }
      });
    }

    console.log('Envio ' + shipmentId + ' marcado como verificado');
  } catch (error) {
    console.error('Error marcando verificado:', error.message);
  }
}

// Sincronizar envios pendientes
async function syncPendingShipments() {
  if (!isWorkingHours()) {
    return;
  }

  console.log('Sincronizando envios pendientes...');

  var existingIds = await getExistingShipmentIds();
  var allShipments = [];

  for (var i = 0; i < accounts.length; i++) {
    var shipments = await getReadyToShipOrders(accounts[i]);
    allShipments = allShipments.concat(shipments);
  }

  var newShipments = allShipments.filter(function(s) {
    return existingIds.indexOf(s.id) === -1;
  });

  if (newShipments.length > 0) {
    await addPendingShipments(newShipments);
  }

  console.log('Sync completado. Nuevos: ' + newShipments.length);
}

// Iniciar sincronizacion cada 1 minuto
setInterval(syncPendingShipments, 60000);
setTimeout(syncPendingShipments, 5000); // Primera sync 5 segundos despues de iniciar

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
  try {
    var response = await mlApiRequest(
      account,
      'https://api.mercadolibre.com/shipments/' + shipmentId
    );
    return { account: account.name, shipment: response.data, token: account.accessToken };
  } catch (error) {
    return null;
  }
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

app.get('/api/debug/shipment/:shipmentId', async function(req, res) {
  var shipmentId = req.params.shipmentId;
  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    if (!account.accessToken) continue;
    try {
      var shipmentResponse = await mlApiRequest(
        account,
        'https://api.mercadolibre.com/shipments/' + shipmentId
      );
      var itemsResponse = await axios.get(
        'https://api.mercadolibre.com/shipments/' + shipmentId + '/items',
        { headers: { 'Authorization': 'Bearer ' + account.accessToken } }
      );
      return res.json({
        account: account.name,
        shipment: shipmentResponse.data,
        items: itemsResponse.data
      });
    } catch (error) {
      continue;
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

  await markAsVerified(shipmentId, items);

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

    var accessToken = response.data.access_token;
    var refreshToken = response.data.refresh_token;

    // Actualizar en memoria
    account.accessToken = accessToken;
    account.refreshToken = refreshToken;

    // Guardar en Google Sheets
    await saveTokenToSheets(account.name, accessToken, refreshToken);

    res.json({
      account: account.name,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: response.data.expires_in,
      saved_to_sheets: true
    });
  } catch (error) {
    res.status(400).json({ error: 'Error al obtener token', details: error.response ? error.response.data : error.message });
  }
});

// ==================== ENDPOINTS DE TOKENS ====================

// Estado de tokens de todas las cuentas
app.get('/api/tokens/status', async function(req, res) {
  var results = [];

  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    var status = {
      account: account.name,
      hasAccessToken: !!account.accessToken,
      hasRefreshToken: !!account.refreshToken,
      hasCredentials: !!(account.clientId && account.clientSecret),
      tokenValid: false,
      error: null
    };

    if (account.accessToken) {
      try {
        // Verificar token haciendo una llamada simple
        await axios.get('https://api.mercadolibre.com/users/me', {
          headers: { 'Authorization': 'Bearer ' + account.accessToken }
        });
        status.tokenValid = true;
      } catch (error) {
        status.tokenValid = false;
        status.error = error.response ? error.response.status + ': ' + (error.response.data.message || 'Token invalido') : error.message;
      }
    }

    results.push(status);
  }

  res.json({
    timestamp: new Date().toISOString(),
    accounts: results
  });
});

// Forzar renovacion de token para una cuenta
app.post('/api/tokens/refresh/:accountName', async function(req, res) {
  var accountName = req.params.accountName;
  var account = accounts.find(function(a) { return a.name === accountName.toUpperCase(); });

  if (!account) {
    return res.status(404).json({ error: 'Cuenta no encontrada' });
  }

  if (!account.refreshToken) {
    return res.status(400).json({ error: 'No hay refresh token disponible para esta cuenta' });
  }

  var success = await refreshAccessToken(account);

  if (success) {
    res.json({
      success: true,
      account: account.name,
      message: 'Token renovado exitosamente'
    });
  } else {
    res.status(500).json({
      success: false,
      account: account.name,
      error: 'Error al renovar token'
    });
  }
});

// ==================== FIN ENDPOINTS DE TOKENS ====================

app.get('/api/status', function(req, res) {
  res.json({
    status: 'OK',
    message: 'Verificador de Envios ML',
    sheets: sheets ? 'conectado' : 'no configurado',
    workingHours: isWorkingHours(),
    accounts: accounts.map(function(a) {
      return {
        name: a.name,
        hasToken: !!a.accessToken,
        hasRefreshToken: !!a.refreshToken
      };
    })
  });
});

// Iniciar servidor despues de cargar tokens
var PORT = process.env.PORT || 3000;

async function startServer() {
  // Cargar tokens desde Sheets antes de iniciar
  await loadTokensFromSheets();

  app.listen(PORT, function() {
    console.log('Servidor corriendo en puerto ' + PORT);
  });
}

startServer();
