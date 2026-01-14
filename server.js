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

function isWorkingHours() {
  var now = new Date();
  var argentinaOffset = -3 * 60;
  var localOffset = now.getTimezoneOffset();
  var argentinaTime = new Date(now.getTime() + (localOffset + argentinaOffset) * 60000);

  var day = argentinaTime.getDay();
  var hour = argentinaTime.getHours();
  var minute = argentinaTime.getMinutes();
  var timeInMinutes = hour * 60 + minute;

  if (day >= 1 && day <= 5 && timeInMinutes >= 510 && timeInMinutes < 1140) {
    return true;
  }
  return false;
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

  var data = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/search', {
    params: {
      seller_id: 'me',
      status: 'ready_to_ship',
      limit: 50
    }
  });

  if (!data) return [];

  var shipments = data.results || [];

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
}

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

    var now = new Date();
    var argentinaOffset = -3 * 60;
    var localOffset = now.getTimezoneOffset();
    var argentinaTime = new Date(now.getTime() + (localOffset + argentinaOffset) * 60000);
    var fecha = argentinaTime.toLocaleDateString('es-AR');
    var hora = argentinaTime.toLocaleTimeString('es-AR');
    var itemsStr = items.map(function(i) { return i.sku; }).join(', ');

    if (rowIndex === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'A:H',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[fecha, hora, shipmentId, '', '', itemsStr, 'Verificado', hora]] }
      });
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'F' + rowIndex + ':H' + rowIndex,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[itemsStr, 'Verificado', hora]] }
      });
    }

    console.log('Envio ' + shipmentId + ' marcado como verificado');
  } catch (error) {
    console.error('Error marcando verificado:', error.message);
  }
}

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
    accounts: accounts.map(function(a) {
      return { name: a.name, hasToken: !!a.accessToken };
    })
  });
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
