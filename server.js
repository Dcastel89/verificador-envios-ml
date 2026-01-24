require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// ============================================
// SISTEMA DE AUTENTICACIÓN
// ============================================

// Credenciales de usuario desde variables de entorno
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'admin123';

// Almacén de sesiones en memoria
var sessions = {};

// Generar token de sesión
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Middleware para parsear cookies
app.use(function(req, res, next) {
  var cookies = {};
  var cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(function(cookie) {
      var parts = cookie.split('=');
      var key = parts[0].trim();
      var value = parts.slice(1).join('=').trim();
      cookies[key] = value;
    });
  }
  req.cookies = cookies;
  next();
});

// Middleware de autenticación
function requireAuth(req, res, next) {
  var token = req.cookies.session_token || req.headers['x-session-token'];

  if (!token || !sessions[token]) {
    return res.status(401).json({ error: 'No autorizado', requireLogin: true });
  }

  // Verificar que la sesión no haya expirado (24 horas)
  var session = sessions[token];
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    delete sessions[token];
    return res.status(401).json({ error: 'Sesión expirada', requireLogin: true });
  }

  req.user = session.user;
  next();
}

// Endpoint de login
app.post('/api/auth/login', function(req, res) {
  var username = req.body.username;
  var password = req.body.password;

  if (username === AUTH_USER && password === AUTH_PASSWORD) {
    var token = generateSessionToken();
    sessions[token] = {
      user: username,
      createdAt: Date.now()
    };

    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 24 horas
    });

    console.log('Login exitoso para usuario: ' + username);
    res.json({ success: true, user: username });
  } else {
    console.log('Intento de login fallido para usuario: ' + username);
    res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
});

// Endpoint de logout
app.post('/api/auth/logout', function(req, res) {
  var token = req.cookies.session_token || req.headers['x-session-token'];

  if (token && sessions[token]) {
    delete sessions[token];
  }

  res.clearCookie('session_token');
  res.json({ success: true });
});

// Endpoint para verificar sesión
app.get('/api/auth/check', function(req, res) {
  var token = req.cookies.session_token || req.headers['x-session-token'];

  if (!token || !sessions[token]) {
    return res.json({ authenticated: false });
  }

  var session = sessions[token];
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    delete sessions[token];
    return res.json({ authenticated: false });
  }

  res.json({ authenticated: true, user: session.user });
});

// Archivos estáticos (sin autenticación para login.html y recursos)
app.use(express.static(path.join(__dirname, 'public')));

// Middleware global de autenticación para todas las rutas /api/ (excepto auth)
app.use('/api', function(req, res, next) {
  // Rutas de autenticación no requieren estar logueado
  if (req.path.startsWith('/auth/')) {
    return next();
  }
  // Todas las demás rutas requieren autenticación
  requireAuth(req, res, next);
});

// Anthropic (Claude) setup
var anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  console.log('Claude API configurada');
}

// Google Sheets setup (solo para Sheets, ya no usamos Vision de Google)
var sheets = null;
var SHEET_ID = process.env.GOOGLE_SHEET_ID;
var HISTORY_SHEET_ID = process.env.GOOGLE_HISTORY_SHEET_ID || '1aioIhNxTBUyILXsX2SpAvIa9Xs4M5NBu_rgMP4Wu3DY';

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

// Mapeo de logistic_type a nombre amigable
function getTipoEnvio(logisticType) {
  if (logisticType === 'self_service') return 'flex';
  if (logisticType === 'drop_off' || logisticType === 'xd_drop_off') return 'despacho';
  if (logisticType === 'cross_docking') return 'colecta';
  return 'otro';
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

function shouldProcessOrder(expectedDate, slaStatus, logisticType, shipmentStatus) {
  // Determina si un envío debe aparecer en el panel del día
  // Criterios:
  // 1. Promesa del día: expected_date es HOY
  // 2. Demorados pendientes: slaStatus es "delayed" Y shipmentStatus es "ready_to_ship"
  // Solo para: Flex (self_service), Colecta (xd_drop_off), Pickit (cross_docking)

  // Filtrar por tipo logístico permitido
  var tiposPermitidos = ['self_service', 'xd_drop_off', 'cross_docking'];
  if (tiposPermitidos.indexOf(logisticType) === -1) {
    return false;
  }

  // Si está demorado Y todavía está en ready_to_ship, incluir
  if (slaStatus === 'delayed' && shipmentStatus === 'ready_to_ship') {
    return true;
  }

  // Si tiene expected_date, verificar si es HOY
  if (expectedDate) {
    var expectedDateStr = expectedDate.split('T')[0]; // "2026-01-16"

    var today = getArgentinaTime();
    var year = today.getFullYear();
    var month = String(today.getMonth() + 1).padStart(2, '0');
    var day = String(today.getDate()).padStart(2, '0');
    var todayStr = year + '-' + month + '-' + day;

    // Solo incluir si la fecha límite es exactamente HOY
    return expectedDateStr === todayStr;
  }

  // Sin expected_date y sin delayed+ready_to_ship → no incluir
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

// Obtener SLA (fecha límite de despacho) desde el endpoint recomendado por ML
// Este endpoint reemplaza el campo deprecated estimated_handling_limit
async function getShipmentSLA(account, shipmentId) {
  try {
    var slaData = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/' + shipmentId + '/sla');
    if (slaData && slaData.expected_date) {
      return {
        expectedDate: slaData.expected_date,
        status: slaData.status || null
      };
    }
    // Log si el SLA no tiene expected_date
    if (slaData) {
      console.log('SLA sin expected_date para envío ' + shipmentId + ':', JSON.stringify(slaData).substring(0, 200));
    }
  } catch (error) {
    console.log('Error obteniendo SLA para envío ' + shipmentId + ':', error.message);
  }
  return null;
}

async function mlApiRequestPost(account, url, data, options = {}) {
  if (!account.accessToken) return null;

  var config = {
    method: 'POST',
    url: url,
    data: data,
    headers: {
      'Authorization': 'Bearer ' + account.accessToken,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  };

  try {
    var response = await axios(config);
    return response.data;
  } catch (error) {
    if (error.response && (error.response.status === 401 || error.response.status === 403)) {
      console.log('Token expirado para ' + account.name + ' (POST), intentando renovar...');
      var renewed = await refreshAccessToken(account);

      if (renewed) {
        config.headers['Authorization'] = 'Bearer ' + account.accessToken;
        try {
          var retryResponse = await axios(config);
          return retryResponse.data;
        } catch (retryError) {
          console.error('Error después de renovar token (POST):', retryError.message);
          return null;
        }
      }
    }
    var errorDetail = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
    console.error('Error en POST API:', error.message, '- Detalle:', errorDetail);
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

  // Agrupar órdenes por shipping_id y manejar packs
  var shipmentMap = {}; // shipping_id -> { orderIds: [], packId: null }
  var processedPacks = {}; // Para evitar procesar el mismo pack múltiples veces

  for (var i = 0; i < ordersWithShipping.length; i++) {
    var order = ordersWithShipping[i];
    var shippingId = order.shipping.id.toString();

    // Inicializar entrada si no existe
    if (!shipmentMap[shippingId]) {
      shipmentMap[shippingId] = {
        orderIds: [],
        packId: null,
        dateCreated: order.date_created
      };
    }

    // Si la orden tiene pack_id, es parte de un carrito
    if (order.pack_id && !processedPacks[order.pack_id]) {
      processedPacks[order.pack_id] = true;
      shipmentMap[shippingId].packId = order.pack_id;

      // Obtener información completa del pack
      try {
        var packData = await mlApiRequest(account, 'https://api.mercadolibre.com/packs/' + order.pack_id);
        if (packData && packData.orders && Array.isArray(packData.orders)) {
          // Agregar todos los order_ids del pack
          packData.orders.forEach(function(packOrder) {
            var packOrderId = packOrder.id ? packOrder.id.toString() : null;
            if (packOrderId && shipmentMap[shippingId].orderIds.indexOf(packOrderId) === -1) {
              shipmentMap[shippingId].orderIds.push(packOrderId);
            }
          });
          console.log(account.name + ' - Pack ' + order.pack_id + ' con ' + packData.orders.length + ' órdenes detectado');
        }
      } catch (packError) {
        // Si falla obtener el pack, agregar solo este order_id
        if (shipmentMap[shippingId].orderIds.indexOf(order.id.toString()) === -1) {
          shipmentMap[shippingId].orderIds.push(order.id.toString());
        }
      }
    } else if (!order.pack_id) {
      // Orden individual (sin pack)
      if (shipmentMap[shippingId].orderIds.indexOf(order.id.toString()) === -1) {
        shipmentMap[shippingId].orderIds.push(order.id.toString());
      }
    }
  }

  // Obtener detalles de cada envío único
  var pendingShipments = [];
  var shippingIds = Object.keys(shipmentMap);
  var logCount = 0;

  for (var j = 0; j < shippingIds.length; j++) {
    var shippingId = shippingIds[j];
    var shipmentInfo = shipmentMap[shippingId];

    // Obtener detalles completos del envío
    var shipment = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/' + shippingId);

    if (!shipment) continue;

    // Log para debug (primeros 5)
    if (logCount < 5) {
      console.log(account.name + ' - Envío ' + shippingId + ': status=' + shipment.status + ', logistic_type=' + shipment.logistic_type + ', mode=' + shipment.mode);
      logCount++;
    }

    var status = shipment.status;

    // Excluir cancelados
    if (status === 'cancelled') {
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

    // Solo agregar envíos en ready_to_ship (no necesitan SLA hasta el filtrado)
    pendingShipments.push({
      id: shippingId,
      orderId: shipmentInfo.orderIds.join(','), // Múltiples order_ids separados por coma
      orderIds: shipmentInfo.orderIds, // Array de order_ids para uso interno
      packId: shipmentInfo.packId,
      account: account.name,
      accountObj: account, // Guardar referencia a la cuenta para llamar al SLA después
      dateCreated: shipmentInfo.dateCreated, // Para display en sheets
      expectedDate: null, // Se llenará después con llamada al SLA
      estimatedHandlingLimitFallback: shipment.estimated_handling_limit, // Fallback si SLA falla
      receiverName: shipment.receiver_address ? shipment.receiver_address.receiver_name : 'N/A',
      logisticType: shipment.logistic_type || '',
      status: status,
      mode: shipment.mode || ''
    });
  }

  console.log(account.name + ' - Envíos pendientes (pre-filtro SLA): ' + pendingShipments.length);

  return pendingShipments;
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
          range: sheetName + '!A1:L1',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [['Fecha', 'Hora', 'Envio', 'Cuenta', 'Receptor', 'SKUs', 'Estado', 'HoraVerif', 'Metodo', 'TipoLogistica', 'Promesa', 'SLA']]
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

    // Limpiar contenido (excepto encabezados) - todas las columnas A-L
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A2:L1000'
    });

    console.log('Hoja ' + sheetName + ' limpiada');
  } catch (error) {
    console.error('Error limpiando hoja:', error.message);
  }
}

async function shouldClearOldRecords(sheetName) {
  // Verifica si los registros existentes son de una semana anterior
  // Retorna true si hay que limpiar, false si no hay registros o son de hoy
  if (!sheets || !SHEET_ID) return false;

  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A2:A2'
    });

    var rows = response.data.values || [];
    if (rows.length === 0 || !rows[0][0]) {
      // No hay registros, no hay que limpiar
      return false;
    }

    var existingDate = rows[0][0]; // Formato: "dd/mm/yyyy" o "d/m/yyyy"
    var today = getArgentinaTime().toLocaleDateString('es-AR');

    // Si la fecha del primer registro no es hoy, son de semana anterior
    if (existingDate !== today) {
      console.log('Registros existentes son de ' + existingDate + ', hoy es ' + today + '. Limpiando hoja.');
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error verificando fecha de registros:', error.message);
    return false;
  }
}

// ============================================
// HISTORIAL MENSUAL
// ============================================

function getMonthlySheetName(date) {
  var argDate = date ? getArgentinaDate(new Date(date)) : getArgentinaTime();
  var year = argDate.getFullYear();
  var month = String(argDate.getMonth() + 1).padStart(2, '0');
  return 'Historial_' + year + '_' + month;
}

async function ensureMonthlySheetExists(sheetName) {
  if (!sheets || !HISTORY_SHEET_ID) return false;

  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: HISTORY_SHEET_ID,
      range: sheetName + '!A1'
    });
    return true;
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: HISTORY_SHEET_ID,
          resource: {
            requests: [{
              addSheet: {
                properties: { title: sheetName }
              }
            }]
          }
        });

        await sheets.spreadsheets.values.update({
          spreadsheetId: HISTORY_SHEET_ID,
          range: sheetName + '!A1:L1',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [['Fecha', 'Hora', 'Envio', 'Cuenta', 'Receptor', 'SKUs', 'Estado', 'HoraVerif', 'Metodo', 'TipoLogistica', 'Promesa', 'SLA']]
          }
        });

        console.log('Hoja de historial ' + sheetName + ' creada exitosamente');
        return true;
      } catch (createError) {
        console.error('Error creando hoja de historial ' + sheetName + ':', createError.message);
        return false;
      }
    }
    return false;
  }
}

var lastHistoryCopyDate = null;

async function copyDailyToHistory() {
  // Copia los registros de la hoja diaria al historial mensual
  // Se ejecuta una vez al día al cierre (19:00)
  var today = getArgentinaTime().toLocaleDateString('es-AR');

  if (lastHistoryCopyDate === today) {
    console.log('Copia al historial ya ejecutada hoy');
    return;
  }

  if (!sheets || !SHEET_ID || !HISTORY_SHEET_ID) {
    console.log('Sheets no configurado para historial');
    return;
  }

  console.log('=== COPIANDO REGISTROS AL HISTORIAL MENSUAL ===');

  var daySheetName = getTodaySheetName();
  var monthSheetName = getMonthlySheetName();

  try {
    // Asegurar que existe la hoja mensual
    await ensureMonthlySheetExists(monthSheetName);

    // Leer todos los registros de la hoja diaria (excepto encabezado)
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: daySheetName + '!A2:L1000'
    });

    var rows = response.data.values || [];
    if (rows.length === 0) {
      console.log('No hay registros para copiar al historial');
      lastHistoryCopyDate = today;
      return;
    }

    // Obtener IDs ya existentes en el historial mensual para evitar duplicados
    var historyResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: HISTORY_SHEET_ID,
      range: monthSheetName + '!C:C'
    });
    var historyRows = historyResponse.data.values || [];
    var existingIds = [];
    for (var i = 1; i < historyRows.length; i++) {
      if (historyRows[i] && historyRows[i][0]) {
        existingIds.push(historyRows[i][0].toString());
      }
    }

    // Filtrar solo registros nuevos
    var newRows = rows.filter(function(row) {
      return row[2] && existingIds.indexOf(row[2].toString()) === -1;
    });

    if (newRows.length === 0) {
      console.log('Todos los registros ya existen en el historial');
      lastHistoryCopyDate = today;
      return;
    }

    // Agregar al historial mensual
    await sheets.spreadsheets.values.append({
      spreadsheetId: HISTORY_SHEET_ID,
      range: monthSheetName + '!A1',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: newRows }
    });

    console.log('Copiados ' + newRows.length + ' registros al historial ' + monthSheetName);
    lastHistoryCopyDate = today;

  } catch (error) {
    console.error('Error copiando al historial:', error.message);
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

      // Formatear promesa de envío (solo fecha, sin hora)
      var promesa = '';
      if (s.expectedDate) {
        promesa = s.expectedDate.split('T')[0]; // "2026-01-16"
      }

      // SLA status: on_time, delayed, early
      var slaStatus = s.slaStatus || '';

      return [fecha, hora, s.id, s.account, s.receiverName, '', 'Pendiente', '', '', s.logisticType || '', promesa, slaStatus];
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A1',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
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
      range: sheetName + '!A:L'
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
      // Append nueva fila con todas las 12 columnas (A-L)
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: sheetName + '!A1',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: [[fecha, hora, shipmentId, '', '', itemsStr, 'Verificado', hora, metodoStr, '', '', '']] }
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
      range: sheetName + '!A:L'
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

async function deleteShipmentRow(shipmentId) {
  // Elimina una fila de envío de la hoja del día
  if (!sheets || !SHEET_ID) return false;

  var sheetName = getTodaySheetName();

  try {
    // Primero obtener el sheetId numérico
    var spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID
    });

    var sheet = spreadsheet.data.sheets.find(function(s) {
      return s.properties.title === sheetName;
    });

    if (!sheet) {
      console.log('Hoja ' + sheetName + ' no encontrada para eliminar envio');
      return false;
    }

    var sheetId = sheet.properties.sheetId;

    // Obtener todas las filas para encontrar el índice
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:L'
    });
    var rows = response.data.values || [];
    var rowIndex = -1;

    for (var i = 1; i < rows.length; i++) {
      if (rows[i][2] && rows[i][2].toString() === shipmentId.toString()) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) {
      console.log('Envio ' + shipmentId + ' no encontrado para eliminar');
      return false;
    }

    // Eliminar la fila usando batchUpdate
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1
            }
          }
        }]
      }
    });

    console.log('Envio cancelado ' + shipmentId + ' eliminado de ' + sheetName);
    return true;
  } catch (error) {
    console.error('Error eliminando envio cancelado:', error.message);
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

  await ensureDaySheetExists(sheetName);

  // Verificar si los registros son de una semana anterior y limpiarlos
  var needsClear = await shouldClearOldRecords(sheetName);
  if (needsClear) {
    await clearDaySheet(sheetName);
  }

  // Obtener IDs existentes para no duplicar y preservar sus estados
  var existingIds = await getExistingShipmentIds(sheetName);
  console.log('Envíos existentes en hoja: ' + existingIds.length);

  var allShipments = [];

  for (var i = 0; i < accounts.length; i++) {
    var shipments = await getReadyToShipOrders(accounts[i]);
    allShipments = allShipments.concat(shipments);
  }

  console.log('Total envíos pre-filtro: ' + allShipments.length + '. Obteniendo SLA en paralelo...');

  // Obtener SLA en paralelo para todos los envíos (máximo 10 concurrentes para no saturar)
  var BATCH_SIZE = 10;
  var slaSuccessCount = 0;
  var slaFallbackCount = 0;
  for (var i = 0; i < allShipments.length; i += BATCH_SIZE) {
    var batch = allShipments.slice(i, i + BATCH_SIZE);
    var slaPromises = batch.map(function(s) {
      return getShipmentSLA(s.accountObj, s.id).then(function(slaData) {
        if (slaData && slaData.expectedDate) {
          s.expectedDate = slaData.expectedDate;
          s.slaStatus = slaData.status || null;
          slaSuccessCount++;
        } else {
          // Fallback a estimated_handling_limit del shipment (sin status)
          s.expectedDate = s.estimatedHandlingLimitFallback || null;
          s.slaStatus = null;
          if (s.expectedDate) slaFallbackCount++;
        }
      }).catch(function() {
        // Fallback a estimated_handling_limit del shipment (sin status)
        s.expectedDate = s.estimatedHandlingLimitFallback || null;
        s.slaStatus = null;
        if (s.expectedDate) slaFallbackCount++;
      });
    });
    await Promise.all(slaPromises);
  }

  console.log('SLA obtenidos: ' + slaSuccessCount + ' del endpoint, ' + slaFallbackCount + ' del fallback');

  // Filtrar: promesa HOY o demorados, solo Flex/Colecta/Pickit
  var filtered = allShipments.filter(function(s) {
    return shouldProcessOrder(s.expectedDate, s.slaStatus, s.logisticType, s.status);
  });

  // Log desglose
  var delayedCount = filtered.filter(function(s) { return s.slaStatus === 'delayed' && s.status === 'ready_to_ship'; }).length;
  var todayCount = filtered.length - delayedCount;
  console.log('Envíos filtrados: ' + filtered.length + ' total (' + todayCount + ' promesa HOY, ' + delayedCount + ' DELAYED+ready_to_ship)');

  // Solo agregar envíos nuevos (addPendingShipments ya filtra duplicados)
  if (filtered.length > 0) {
    await addPendingShipments(filtered, sheetName);
  }

  lastMorningSyncDate = today;
  console.log('Sync matutino completado. Total desde ML: ' + filtered.length + ', existentes preservados: ' + existingIds.length);
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

  // Copia al historial mensual a las 19:00 (1140 minutos)
  if (timeInMinutes >= 1140 && timeInMinutes < 1145) {
    await copyDailyToHistory();
    return;
  }

  // No sincronizar fuera de horario laboral
  if (!isWorkingHours()) {
    return;
  }

  // Sync incremental durante el día
  console.log('Sincronizando envios pendientes...');

  var sheetName = getTodaySheetName();

  // Verificar si los registros son de una semana anterior y limpiarlos
  // (por si el servidor se reinició y el sync matutino no se ejecutó)
  await ensureDaySheetExists(sheetName);
  var needsClear = await shouldClearOldRecords(sheetName);
  if (needsClear) {
    await clearDaySheet(sheetName);
  }

  var existingIds = await getExistingShipmentIds(sheetName);
  var allShipments = [];

  for (var i = 0; i < accounts.length; i++) {
    var shipments = await getReadyToShipOrders(accounts[i]);
    allShipments = allShipments.concat(shipments);
  }

  // Filtrar solo los nuevos ANTES de obtener SLA (optimización)
  var newShipments = allShipments.filter(function(s) {
    return existingIds.indexOf(s.id) === -1;
  });

  if (newShipments.length === 0) {
    console.log('Sync completado. No hay envíos nuevos.');
    return;
  }

  // Obtener SLA en paralelo solo para envíos nuevos
  var BATCH_SIZE = 10;
  for (var i = 0; i < newShipments.length; i += BATCH_SIZE) {
    var batch = newShipments.slice(i, i + BATCH_SIZE);
    var slaPromises = batch.map(function(s) {
      return getShipmentSLA(s.accountObj, s.id).then(function(slaData) {
        if (slaData && slaData.expectedDate) {
          s.expectedDate = slaData.expectedDate;
          s.slaStatus = slaData.status || null;
        } else {
          // Fallback a estimated_handling_limit del shipment (sin status)
          s.expectedDate = s.estimatedHandlingLimitFallback || null;
          s.slaStatus = null;
        }
      }).catch(function() {
        // Fallback a estimated_handling_limit del shipment (sin status)
        s.expectedDate = s.estimatedHandlingLimitFallback || null;
        s.slaStatus = null;
      });
    });
    await Promise.all(slaPromises);
  }

  // Filtrar: promesa HOY o demorados, solo Flex/Colecta/Pickit
  var filtered = newShipments.filter(function(s) {
    return shouldProcessOrder(s.expectedDate, s.slaStatus, s.logisticType, s.status);
  });

  if (filtered.length > 0) {
    await addPendingShipments(filtered, sheetName);
  }

  console.log('Sync completado. Nuevos: ' + filtered.length);
}

// Sync automático desactivado - ahora se usa solo sync manual + webhooks
// setInterval(syncPendingShipments, 60000);

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

  if (sku.startsWith('FAN')) {
    var colors = { 'N': 'Negra', 'R': 'Roja', 'A': 'Azul' };
    var colorCode = sku.charAt(sku.length - 1);
    var color = colors[colorCode] || colorCode;
    var modelo = sku.substring(3, sku.length - 1);
    return 'Funda Anillo ' + color + ' ' + modelo;
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

    // Extraer cantidad entre paréntesis si existe, ej: "ABC (3)" -> sku: "ABC", quantity: 3
    var quantityMatch = part.match(/\s*\((\d+)\)\s*$/);
    var quantity = 1;
    var cleanSku = part;
    if (quantityMatch) {
      quantity = parseInt(quantityMatch[1], 10);
      cleanSku = part.replace(/\s*\(\d+\)\s*$/, '').trim();
    }

    if (cleanSku === '') continue;
    if (seen[cleanSku]) {
      // Si ya existe, sumar la cantidad
      for (var j = 0; j < components.length; j++) {
        if (components[j].sku === cleanSku) {
          components[j].quantity += quantity;
          break;
        }
      }
      continue;
    }
    seen[cleanSku] = true;
    components.push({ sku: cleanSku, quantity: quantity });
  }
  return components;
}

async function findShipmentInAccount(account, shipmentId) {
  if (!account.accessToken) return null;

  var data = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/' + shipmentId);

  if (data) {
    return { account: account.name, shipment: data, accountObj: account };
  }
  return null;
}

async function getShipmentItems(account, shipmentId) {
  var data = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/' + shipmentId + '/items');
  return data || [];
}

async function getItemWithVariations(account, itemId) {
  return await mlApiRequest(account, 'https://api.mercadolibre.com/items/' + itemId + '?include_attributes=all');
}

async function getUserProductSKU(account, userProductId) {
  if (!userProductId) return null;
  var data = await mlApiRequest(account, 'https://api.mercadolibre.com/user-products/' + userProductId);
  if (data && data.attributes) {
    for (var i = 0; i < data.attributes.length; i++) {
      var attr = data.attributes[i];
      if (attr.id === 'SELLER_SKU' && attr.values && attr.values[0] && attr.values[0].name) {
        return attr.values[0].name;
      }
    }
  }
  return null;
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

  var accountObj = found.accountObj;
  var items = await getShipmentItems(accountObj, shipmentId);
  var processedItems = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var sku = null;

    if (item.variation_id) {
      var itemData = await getItemWithVariations(accountObj, item.item_id);
      sku = findSKUInVariation(itemData, item.variation_id);
    }

    if (!sku && item.user_product_id) {
      sku = await getUserProductSKU(accountObj, item.user_product_id);
    }

    var components = parseSKU(sku);
    var title = item.description || 'Sin titulo';

    if (components.length > 1) {
      for (var j = 0; j < components.length; j++) {
        var component = components[j];
        processedItems.push({
          id: item.item_id + '-' + component.sku,
          title: title,
          sku: component.sku,
          description: describeSKU(component.sku),
          quantity: item.quantity * component.quantity,
          isKit: true,
          originalSku: sku
        });
      }
    } else if (components.length === 1) {
      processedItems.push({
        id: item.item_id,
        title: title,
        sku: components[0].sku,
        description: describeSKU(components[0].sku),
        quantity: item.quantity * components[0].quantity,
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

  // Obtener SLA (fecha límite de despacho) desde el endpoint recomendado por ML
  var slaData = await getShipmentSLA(accountObj, shipmentId);
  var expectedDate = slaData ? slaData.expectedDate : null;

  // Contar cantidad de vidrios e hidrogeles en el envío
  var glassCount = 0;
  var hydrogelCount = 0;
  processedItems.forEach(function(item) {
    if (item.sku && item.sku.startsWith('VF')) {
      glassCount += item.quantity;
    }
    if (item.sku && item.sku.toLowerCase().includes('hidrogel')) {
      hydrogelCount += item.quantity;
    }
  });

  // Agregar ítem de verificación "Papelitos 1y2" si hay vidrio o hidrogel
  var papelitosCount = glassCount + hydrogelCount;
  if (papelitosCount > 0) {
    processedItems.push({
      id: 'verification-papelitos',
      title: 'Verificación adicional',
      sku: 'PAPELITOS',
      description: 'Papelitos 1y2',
      quantity: 1,  // Solo 1 checkbox
      displayQuantity: papelitosCount,  // Cantidad real a incluir
      isKit: false,
      isVerificationOnly: true
    });
  }

  // Agregar ítem de verificación "Cartoncito Colocador" si hay hidrogel
  if (hydrogelCount > 0) {
    processedItems.push({
      id: 'verification-cartoncito',
      title: 'Verificación adicional',
      sku: 'CARTONCITO',
      description: 'Cartoncito Colocador',
      quantity: 1,  // Solo 1 checkbox
      displayQuantity: hydrogelCount,  // Cantidad real a incluir
      isKit: false,
      isVerificationOnly: true
    });
  }

  res.json({
    account: found.account,
    shipmentId: shipmentId,
    status: found.shipment.status,
    logisticType: found.shipment.logistic_type,
    expectedDate: expectedDate, // Fecha límite de despacho del SLA (reemplaza estimated_handling_limit deprecado)
    estimatedDeliveryTime: found.shipment.estimated_delivery_time,
    dateCreated: found.shipment.date_created,
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

// ============================================
// VISION API - Verificación inteligente con Claude
// ============================================

app.post('/api/vision/analyze', async function(req, res) {
  if (!anthropic) {
    return res.status(500).json({ error: 'Claude API no configurada. Agregá ANTHROPIC_API_KEY en las variables de entorno.' });
  }

  var imageBase64 = req.body.image;
  var productoEsperado = req.body.producto; // Info del pedido: título, descripción, SKU esperado, etc.

  if (!imageBase64) {
    return res.status(400).json({ error: 'No se recibió imagen' });
  }

  // Remover prefijo data:image si existe y detectar tipo
  var mediaType = 'image/jpeg';
  if (imageBase64.includes('data:image/')) {
    var matches = imageBase64.match(/data:(image\/[a-z]+);base64,/);
    if (matches) {
      mediaType = matches[1];
    }
    imageBase64 = imageBase64.split('base64,')[1];
  }

  try {
    var prompt = '';

    if (productoEsperado) {
      // MODO VERIFICACIÓN: Comparar imagen con producto esperado
      prompt = `Sos un verificador de pedidos. Tu trabajo es confirmar si el producto en la foto coincide con lo que se pidió.

PRODUCTO ESPERADO DEL PEDIDO:
${typeof productoEsperado === 'string' ? productoEsperado : JSON.stringify(productoEsperado, null, 2)}

REGLAS DE COMPARACIÓN DE MODELOS:

1. IGNORAR TEXTO EXTRA EN ETIQUETAS - Solo importa el código de modelo:
   - Ignorar marcas: "MOTO G15" = "G15", "Samsung A25" = "A25"
   - Ignorar texto adicional: "SX", "For", "Galaxy", "Phone case", etc.
   - Ejemplo: "For Samsung Galaxy A25 SX" = "A25" ✓

2. SUFIJOS IMPORTANTES QUE DEBEN COINCIDIR EXACTAMENTE:
   Plus (o +), Ultra, Pro, Pro Max, Air, Fusion, Neo
   - A15 ≠ A15 Plus (Plus es importante)
   - iPhone 15 ≠ iPhone 15 Pro Max (Pro Max es importante)
   - A55 ≠ A55 Ultra (Ultra es importante)
   - Redmi Note 14 ≠ Redmi Note 14 Pro (Pro es importante)

3. OTROS SUFIJOS TAMBIÉN SON DIFERENTES - Ser estricto:
   - A03 ≠ A03s ≠ A03 Core (son modelos distintos!)
   - A15 ≠ A16 (números diferentes = modelos diferentes)
   - G24 ≠ G24 Power (con sufijo = modelo diferente)
   - Redmi 14 ≠ Redmi Note 14 (Note es otro modelo)

4. EJEMPLOS DE COINCIDENCIAS CORRECTAS:
   - Pedido "G15", foto dice "MOTO G15" → CORRECTO (ignorar MOTO)
   - Pedido "A25", foto dice "For Samsung Galaxy A25 SX" → CORRECTO (ignorar texto extra)
   - Pedido "A15 Plus", foto dice "A15+" → CORRECTO (+ equivale a Plus)

5. EJEMPLOS DE COINCIDENCIAS INCORRECTAS:
   - Pedido "A03", foto dice "A03s" → INCORRECTO (sufijo s es diferente)
   - Pedido "A15", foto dice "A15 Plus" → INCORRECTO (Plus es importante)
   - Pedido "iPhone 15", foto dice "iPhone 15 Pro" → INCORRECTO (Pro es importante)
   - Pedido "G24", foto dice "G24 Power" → INCORRECTO (variante diferente)

6. REGLA ESPECIAL PARA FUNDAS Y 4G/5G:
   - Para fundas: IGNORAR "4G" o "5G" esté separado O PEGADO al modelo
   - "A265G", "A265g", "A26 5G", "A26 5g" → todos son "A26"
   - "A154G", "A15 4G" → es "A15"
   - EXCEPCIÓN ÚNICA: A22 (sí distinguir A22 4G vs A22 5G)
   - Ejemplo: Pedido "A26", foto dice "A265G" → CORRECTO (ignorar 5G pegado)
   - Ejemplo: Pedido "A26", foto dice "A26 5g" → CORRECTO (ignorar 5g)
   - Ejemplo: Pedido "A22 4G", foto dice "A225G" → INCORRECTO (A22 es excepción)

INSTRUCCIONES:
1. Extraé el CÓDIGO DE MODELO de la etiqueta (ignorá la marca)
2. Compará el código con el pedido usando las reglas anteriores
3. Verificá que el COLOR coincida

IMPORTANTE:
- El fondo suele ser madera, ignoralo
- Las fundas vienen en bolsas transparentes con etiquetas
- Colores comunes: Negro, Blanco, Transparente, Rojo, Azul, Rosa, Lila, Verde, Celeste, Amarillo

Respondé SOLO con este JSON:
{
  "correcto": true/false,
  "productoDetectado": "descripción breve de lo que ves en la foto",
  "modeloDetectado": "código del modelo sin marca (ej: A25, G15, no Samsung A25)",
  "colorDetectado": "color del producto",
  "motivo": "si es incorrecto, explicá por qué usando las reglas",
  "confianza": "alta/media/baja"
}`;
    } else {
      // MODO EXTRACCIÓN: Solo extraer info de la imagen (sin comparar)
      prompt = `Analizá esta imagen de un producto (funda de celular).

Extraé:
1. **Modelo/SKU**: Buscá códigos en etiquetas (A25, A36, B12, "For A06", etc.)
2. **Color**: Color real del producto (no del fondo de madera)
3. **Tipo**: Qué tipo de producto es

IGNORAR en el modelo: "Fashion Case", "New", "Phone case", "Made in China", "SX", "For", "Galaxy", marcas como "Samsung", "MOTO", "Xiaomi"

SUFIJOS IMPORTANTES QUE SÍ DEBEN INCLUIRSE EN EL MODELO:
Plus (o +), Ultra, Pro, Pro Max, Air, Fusion, Neo
- Si dice "A15+" reportar "A15 Plus"
- Si dice "iPhone 15 Pro Max" reportar "15 Pro Max"

REGLA 4G/5G (MUY IMPORTANTE):
- IGNORAR "4G" o "5G" esté separado O PEGADO al modelo
- "A265G" → reportar "A26" (quitar el 5G pegado)
- "A265g" → reportar "A26"
- "A26 5G" → reportar "A26"
- "A154G" → reportar "A15"
- EXCEPCIÓN ÚNICA: A22 (reportar "A22 4G" o "A22 5G")

Respondé SOLO con este JSON:
{
  "modeloDetectado": "código encontrado o null",
  "colorDetectado": "color del producto",
  "tipoProducto": "funda silicona/funda transparente/vidrio/etc",
  "confianza": "alta/media/baja"
}`;
    }

    var response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: imageBase64
            }
          },
          { type: 'text', text: prompt }
        ]
      }]
    });

    // Parsear respuesta de Claude
    var claudeText = response.content[0].text.trim();
    console.log('Claude response:', claudeText);

    // Intentar extraer JSON de la respuesta (puede venir con ```json ... ```)
    var jsonMatch = claudeText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({
        error: 'Claude no devolvió JSON válido',
        rawResponse: claudeText
      });
    }

    var result = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('Error en Claude Vision:', error.message);
    res.status(500).json({ error: 'Error procesando imagen con Claude: ' + error.message });
  }
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

// Endpoint unificado para sincronizar envíos y actualizar estados
app.get('/api/sync-morning', async function(req, res) {
  try {
    var sheetName = getTodaySheetName();

    // 1. Sincronizar envíos nuevos desde ML
    lastMorningSyncDate = null;
    await syncMorningShipments();

    // 2. Actualizar estados de envíos existentes
    var actualizados = await actualizarEstadosEnvios();

    res.json({
      success: true,
      message: 'Sincronización completada',
      hoja: sheetName,
      estadosActualizados: actualizados
    });
  } catch (error) {
    console.error('Error en sync:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Función auxiliar para actualizar estados (usada por sync unificado)
async function actualizarEstadosEnvios() {
  if (!sheets || !SHEET_ID) return 0;

  var sheetName = getTodaySheetName();
  var actualizados = 0;

  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:L'
    });

    var rows = response.data.values || [];

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row[2]) continue;

      var envioId = row[2];
      var cuenta = row[3] || '';
      var estadoActual = row[6] || '';

      if (estadoActual === 'Verificado' || estadoActual === 'Despachado' || estadoActual === 'Entregado') {
        continue;
      }

      var account = accounts.find(function(a) {
        return a.name.toUpperCase() === cuenta.toUpperCase();
      });

      if (!account || !account.accessToken) continue;

      var estadoML = await getShipmentStatus(account, envioId);

      if (estadoML && estadoML !== 'ready_to_ship') {
        // Si está cancelado, eliminar de la hoja
        if (estadoML === 'cancelled') {
          var eliminado = await deleteShipmentRow(envioId);
          if (eliminado) actualizados++;
        } else {
          // Para otros estados (shipped, delivered, etc.), marcar el estado
          var estadoTexto = 'Despachado';
          if (estadoML === 'delivered') estadoTexto = 'Entregado';

          var marcado = await markAsDespachado(envioId, estadoTexto);
          if (marcado) actualizados++;
        }
      }

      await new Promise(function(resolve) { setTimeout(resolve, 50); });
    }
  } catch (error) {
    console.error('Error actualizando estados:', error.message);
  }

  return actualizados;
}

// Endpoint para obtener envíos del día desde Google Sheets (persistente)
app.get('/api/envios-del-dia', async function(req, res) {
  try {
    var sheetName = getTodaySheetName();
    var now = getArgentinaTime();

    if (!sheets || !SHEET_ID) {
      return res.json({
        fecha: now.toLocaleDateString('es-AR'),
        total: 0,
        envios: []
      });
    }

    await ensureDaySheetExists(sheetName);

    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:L'
    });

    var rows = response.data.values || [];
    var envios = [];

    // Saltar encabezado (fila 0)
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row[2]) continue; // Sin ID de envío

      envios.push({
        id: row[2] || '',
        cuenta: row[3] || '',
        receptor: row[4] || '',
        estado: row[6] || 'Pendiente',
        logisticType: row[9] || ''
      });
    }

    res.json({
      fecha: now.toLocaleDateString('es-AR'),
      total: envios.length,
      envios: envios
    });
  } catch (error) {
    console.error('Error obteniendo envios del dia:', error.message);
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

    // Manejar packs (carritos) - obtener todos los order_ids relacionados
    var allOrderIds = [orderId];
    var packId = orderData.pack_id || null;

    if (packId) {
      try {
        var packData = await mlApiRequest(account, 'https://api.mercadolibre.com/packs/' + packId);
        if (packData && packData.orders && Array.isArray(packData.orders)) {
          allOrderIds = packData.orders.map(function(o) { return o.id ? o.id.toString() : null; }).filter(Boolean);
          console.log('Pack ' + packId + ' detectado con ' + allOrderIds.length + ' órdenes');
        }
      } catch (packError) {
        console.log('Error obteniendo pack ' + packId + ':', packError.message);
      }
    }

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

    // Verificar status del envío
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

    // Obtener SLA (fecha límite de despacho) desde el endpoint recomendado por ML
    var slaData = await getShipmentSLA(account, shipmentId);
    var expectedDate = slaData ? slaData.expectedDate : null;
    var slaStatus = slaData ? slaData.status : null;

    // Verificar: promesa HOY o (demorado + ready_to_ship), solo Flex/Colecta/Pickit
    if (!shouldProcessOrder(expectedDate, slaStatus, shipmentData.logistic_type, shipmentData.status)) {
      var tipoEnvio = getTipoEnvio(shipmentData.logistic_type);
      console.log('Envío no cumple criterios para ' + account.name + '/' + tipoEnvio + ', ignorando:', orderId);
      return;
    }

    var shipment = {
      id: shipmentId,
      orderId: allOrderIds.join(','), // Múltiples order_ids separados por coma
      orderIds: allOrderIds, // Array de order_ids
      packId: packId,
      account: account.name,
      dateCreated: dateCreated, // Para display en sheets
      expectedDate: expectedDate, // Fecha límite de despacho del SLA
      receiverName: shipmentData.receiver_address ? shipmentData.receiver_address.receiver_name : 'N/A',
      logisticType: shipmentData.logistic_type
    };

    await addPendingShipments([shipment], sheetName);
    console.log('Nuevo envío agregado via webhook:', shipmentId, 'cuenta:', account.name, packId ? '(pack: ' + packId + ')' : '');
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

    // Leer datos de la hoja del día (todas las columnas A-J)
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:L'
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

// Endpoint para copiar registros del día al historial mensual
app.post('/api/copiar-historial', async function(req, res) {
  try {
    // Resetear la fecha para forzar la copia
    lastHistoryCopyDate = null;
    await copyDailyToHistory();
    res.json({ success: true, message: 'Copia al historial ejecutada' });
  } catch (error) {
    console.error('Error copiando al historial:', error.message);
    res.json({ error: error.message });
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
      range: sheetName + '!A:L'
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

    // Limpiar y reescribir la hoja sin duplicados (todas las columnas A-J)
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:L'
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

  // Obtener SLA (fecha límite de despacho) desde el endpoint recomendado por ML
  var slaData = await getShipmentSLA(accountFound, shipmentId);
  var expectedDate = slaData ? slaData.expectedDate : null;

  // Crear el objeto de envío
  var shipment = {
    id: shipmentId,
    orderId: orderId,
    account: accountFound.name,
    dateCreated: orderData.date_created, // Para display en sheets
    expectedDate: expectedDate, // Fecha límite de despacho del SLA
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

// Endpoint de diagnóstico para investigar por qué una orden no aparece
app.get('/api/diagnostico/:orderId', async function(req, res) {
  var orderId = req.params.orderId;
  var diagnostico = {
    orderId: orderId,
    pasos: []
  };

  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    if (!account.accessToken) continue;

    var orderData = await mlApiRequest(account, 'https://api.mercadolibre.com/orders/' + orderId);

    if (orderData && orderData.id) {
      diagnostico.cuenta = account.name;
      diagnostico.pasos.push({ paso: 'Orden encontrada en cuenta ' + account.name, ok: true });

      // Verificar status
      if (orderData.status !== 'paid') {
        diagnostico.pasos.push({ paso: 'Status de orden', ok: false, motivo: 'Status es "' + orderData.status + '", se requiere "paid"' });
        return res.json(diagnostico);
      }
      diagnostico.pasos.push({ paso: 'Status es "paid"', ok: true });

      // Verificar shipping
      if (!orderData.shipping || !orderData.shipping.id) {
        diagnostico.pasos.push({ paso: 'Shipping ID', ok: false, motivo: 'La orden no tiene shipping.id' });
        return res.json(diagnostico);
      }
      diagnostico.pasos.push({ paso: 'Tiene shipping.id: ' + orderData.shipping.id, ok: true });

      // Obtener datos del envío
      var shipmentData = await mlApiRequest(account, 'https://api.mercadolibre.com/shipments/' + orderData.shipping.id);
      if (!shipmentData) {
        diagnostico.pasos.push({ paso: 'Obtener shipment', ok: false, motivo: 'No se pudo obtener datos del envío' });
        return res.json(diagnostico);
      }
      diagnostico.pasos.push({ paso: 'Shipment obtenido', ok: true });

      // Verificar status del envío
      if (shipmentData.status === 'cancelled') {
        diagnostico.pasos.push({ paso: 'Status del envío', ok: false, motivo: 'Envío cancelado' });
        return res.json(diagnostico);
      }
      diagnostico.pasos.push({ paso: 'Envío no cancelado (status: ' + shipmentData.status + ')', ok: true });

      // Verificar fulfillment
      if (shipmentData.logistic_type === 'fulfillment') {
        diagnostico.pasos.push({ paso: 'Tipo logístico', ok: false, motivo: 'Es fulfillment (FULL), se excluye' });
        return res.json(diagnostico);
      }
      diagnostico.pasos.push({ paso: 'Tipo logístico: ' + shipmentData.logistic_type, ok: true });

      // Verificar mode
      if (shipmentData.mode === 'not_specified' || shipmentData.mode === 'custom') {
        diagnostico.pasos.push({ paso: 'Modo de envío', ok: false, motivo: 'Modo es "' + shipmentData.mode + '" (acordar con comprador)' });
        return res.json(diagnostico);
      }
      diagnostico.pasos.push({ paso: 'Modo: ' + shipmentData.mode, ok: true });

      // Obtener SLA (fecha límite de despacho) desde el endpoint recomendado por ML
      var tipoEnvio = getTipoEnvio(shipmentData.logistic_type);
      var slaData = await getShipmentSLA(account, orderData.shipping.id.toString());
      var expectedDate = slaData ? slaData.expectedDate : null;
      var slaStatus = slaData ? slaData.status : null;

      var today = getArgentinaTime();
      var year = today.getFullYear();
      var month = String(today.getMonth() + 1).padStart(2, '0');
      var day = String(today.getDate()).padStart(2, '0');
      var todayStr = year + '-' + month + '-' + day;

      var expectedDateStr = expectedDate ? expectedDate.split('T')[0] : null;

      diagnostico.pasos.push({
        paso: 'SLA - Fecha límite: ' + (expectedDateStr || 'N/A') + ', Status: ' + (slaStatus || 'N/A'),
        ok: true
      });
      diagnostico.pasos.push({
        paso: 'Fecha actual: ' + todayStr,
        ok: true
      });

      // Verificar tipo logístico permitido
      var tiposPermitidos = ['self_service', 'xd_drop_off', 'cross_docking'];
      if (tiposPermitidos.indexOf(shipmentData.logistic_type) === -1) {
        diagnostico.pasos.push({
          paso: 'Tipo logístico permitido',
          ok: false,
          motivo: 'Solo se procesan Flex (self_service), Colecta (xd_drop_off) y Pickit (cross_docking). Este es: ' + shipmentData.logistic_type
        });
        return res.json(diagnostico);
      }
      diagnostico.pasos.push({ paso: 'Tipo logístico permitido: ' + shipmentData.logistic_type, ok: true });

      var pasaFiltro = shouldProcessOrder(expectedDate, slaStatus, shipmentData.logistic_type, shipmentData.status);
      if (!pasaFiltro) {
        var motivo = 'No cumple criterios: fecha límite no es HOY (' + expectedDateStr + ' != ' + todayStr + ') o está demorado pero no en ready_to_ship (slaStatus: ' + slaStatus + ', shipmentStatus: ' + shipmentData.status + ')';
        diagnostico.pasos.push({ paso: 'Filtro de promesa/demora', ok: false, motivo: motivo });
        return res.json(diagnostico);
      }

      if (slaStatus === 'delayed' && shipmentData.status === 'ready_to_ship') {
        diagnostico.pasos.push({ paso: 'Pasa filtro: DEMORADO + ready_to_ship', ok: true });
      } else {
        diagnostico.pasos.push({ paso: 'Pasa filtro: promesa de envío es HOY', ok: true });
      }

      // Verificar si ya existe en el sheet
      var sheetName = getTodaySheetName();
      var shipmentId = orderData.shipping.id.toString();
      try {
        var response = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: sheetName + '!C:C'
        });
        var existingIds = (response.data.values || []).map(function(row) { return row[0]; });
        var yaExiste = existingIds.includes(shipmentId);

        if (yaExiste) {
          diagnostico.pasos.push({ paso: 'Ya existe en ' + sheetName, ok: true, nota: 'El envío YA está en la hoja de hoy' });
        } else {
          diagnostico.pasos.push({ paso: 'No existe en ' + sheetName, ok: false, motivo: 'El envío NO está en la hoja de hoy pero DEBERÍA estar' });
        }
      } catch (err) {
        diagnostico.pasos.push({ paso: 'Verificar sheet', ok: false, motivo: 'Error: ' + err.message });
      }

      diagnostico.conclusion = pasaFiltro ? 'La orden DEBERÍA aparecer' : 'La orden está correctamente filtrada';
      return res.json(diagnostico);
    }
  }

  diagnostico.pasos.push({ paso: 'Buscar orden', ok: false, motivo: 'Orden no encontrada en ninguna cuenta' });
  res.json(diagnostico);
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

    // Leer todos los envíos de la hoja (todas las columnas A-J)
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:L'
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
        // Si está cancelado, eliminar de la hoja
        if (estadoML === 'cancelled') {
          var eliminado = await deleteShipmentRow(envioId);
          if (eliminado) {
            actualizados++;
          }
        } else {
          // Mapear estados de ML a texto legible
          var estadoTexto = 'Despachado';
          if (estadoML === 'shipped') {
            estadoTexto = 'Despachado';
          } else if (estadoML === 'delivered') {
            estadoTexto = 'Entregado';
          } else if (estadoML === 'not_delivered') {
            estadoTexto = 'No entregado';
          }

          var marcado = await markAsDespachado(envioId, estadoTexto);
          if (marcado) {
            actualizados++;
          }
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
    console.log('Datos cargados exitosamente');
  } catch (error) {
    console.error('Error cargando datos:', error.message);
  }

  app.listen(PORT, function() {
    console.log('Servidor corriendo en puerto ' + PORT);
    setTimeout(syncPendingShipments, 5000);
  });
}

initializeServer();
