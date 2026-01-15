require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Google Sheets setup
var sheets = null;
var vision = null;
var SHEET_ID = process.env.GOOGLE_SHEET_ID;

if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  var auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/cloud-vision'
    ]
  );
  sheets = google.sheets({ version: 'v4', auth: auth });
  vision = google.vision({ version: 'v1', auth: auth });
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
var lastHorariosLoadDate = null; // Para cargar horarios solo una vez al día

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

// ============================================
// OBTENCIÓN DE HORARIOS DESDE API DE ML
// ============================================

async function getCutoffTimeFlex(account) {
  // Obtiene el horario de corte de FLEX desde la API de ML
  if (!account.accessToken) return null;

  try {
    // Primero obtener el user ID
    var userInfo = await mlApiRequest(account, 'https://api.mercadolibre.com/users/me');
    if (!userInfo || !userInfo.id) {
      console.log(account.name + ' - No se pudo obtener user ID para horarios FLEX');
      return null;
    }
    var userId = userInfo.id;

    // Paso 1: Obtener las suscripciones para conseguir el service_id
    var subscriptionsUrl = 'https://api.mercadolibre.com/shipping/flex/sites/MLA/users/' + userId + '/subscriptions/v1';
    var subscriptions = await mlApiRequest(account, subscriptionsUrl);

    if (!subscriptions || !Array.isArray(subscriptions) || subscriptions.length === 0) {
      console.log(account.name + ' - No tiene suscripciones FLEX activas');
      return null;
    }

    // Buscar suscripción activa de Flex (case-insensitive)
    var flexSubscription = subscriptions.find(function(sub) {
      var mode = sub.mode ? sub.mode.toLowerCase() : '';
      var statusId = sub.status && sub.status.id ? sub.status.id.toLowerCase() : '';
      return mode === 'flex' && statusId === 'in';
    });

    if (!flexSubscription || !flexSubscription.service_id) {
      console.log(account.name + ' - No se encontró suscripción FLEX activa');
      return null;
    }

    var serviceId = flexSubscription.service_id;
    console.log(account.name + ' - Service ID FLEX: ' + serviceId);

    // Paso 2: Obtener configuración con user_id y service_id (formato GraphQL)
    var configUrl = 'https://api.mercadolibre.com/shipping/flex/sites/MLA/configuration/v3';

    // Query GraphQL simplificada - solo campos necesarios para cutoff
    var graphqlQuery = '{ configuration (user_id: ' + userId + ', service_id: ' + serviceId + ') { delivery_ranges { week { from to calculated_cutoff } saturday { calculated_cutoff } sunday { calculated_cutoff } } delivery_window } }';

    console.log(account.name + ' - Consultando FLEX config para user=' + userId + ', service=' + serviceId);
    var responseData = await mlApiRequestPost(account, configUrl, { query: graphqlQuery });

    // Si GraphQL falla, intentar endpoint REST alternativo
    if (!responseData) {
      console.log(account.name + ' - GraphQL falló, intentando endpoint REST alternativo...');
      var restUrl = 'https://api.mercadolibre.com/shipping/flex/sites/MLA/users/' + userId + '/services/' + serviceId + '/configuration/v3';
      responseData = await mlApiRequest(account, restUrl);
    }

    if (!responseData) {
      console.log(account.name + ' - No se pudo obtener configuración de FLEX');
      return null;
    }

    // La respuesta puede venir en diferentes formatos
    var configData = responseData.data ? responseData.data.configuration : (responseData.configuration || responseData);

    if (!configData) {
      configData = responseData; // Usar respuesta directa si no tiene wrapper
    }

    console.log(account.name + ' - FLEX config recibida:', JSON.stringify(configData).substring(0, 200));

    // Opción 1: delivery_window directo (formato HH:MM)
    if (configData.delivery_window) {
      var dw = configData.delivery_window;
      if (typeof dw === 'string' && dw.includes(':')) {
        var parts = dw.split(':');
        var minutos = parseInt(parts[0]) * 60 + (parts[1] ? parseInt(parts[1]) : 0);
        console.log(account.name + ' - Cutoff FLEX obtenido (delivery_window): ' + dw);
        return minutos;
      }
    }

    // Opción 2: Extraer el cutoff de delivery_ranges.week
    if (configData.delivery_ranges && configData.delivery_ranges.week) {
      var weekRanges = configData.delivery_ranges.week;
      if (Array.isArray(weekRanges) && weekRanges.length > 0) {
        var cutoff = weekRanges[0].calculated_cutoff || weekRanges[0].cutoff;
        if (cutoff !== null && cutoff !== undefined) {
          if (typeof cutoff === 'number') {
            console.log(account.name + ' - Cutoff FLEX obtenido: ' + cutoff + ':00');
            return cutoff * 60;
          } else if (typeof cutoff === 'string') {
            var parts = cutoff.split(':');
            if (parts.length >= 1) {
              var minutos = parseInt(parts[0]) * 60 + (parts[1] ? parseInt(parts[1]) : 0);
              console.log(account.name + ' - Cutoff FLEX obtenido: ' + cutoff);
              return minutos;
            }
          }
        }
      }
    }

    // Opción 3: buscar en availables
    if (configData.availables && configData.availables.cutoff !== undefined) {
      var cutoff = configData.availables.cutoff;
      if (typeof cutoff === 'number') {
        console.log(account.name + ' - Cutoff FLEX obtenido (availables): ' + cutoff + ':00');
        return cutoff * 60;
      }
    }

    console.log(account.name + ' - No se encontró cutoff en configuración de FLEX');
    return null;
  } catch (error) {
    console.error(account.name + ' - Error obteniendo cutoff FLEX:', error.message);
    return null;
  }
}

async function getCutoffTimeColecta(account) {
  // Obtiene el horario de corte de COLECTA (cross_docking) desde la API de ML
  if (!account.accessToken) return null;

  try {
    // Primero obtener el user ID y verificar si tiene Multi-Origin
    var userInfo = await mlApiRequest(account, 'https://api.mercadolibre.com/users/me');
    if (!userInfo || !userInfo.id) {
      console.log(account.name + ' - No se pudo obtener user ID para horarios COLECTA');
      return null;
    }
    var userId = userInfo.id;

    // Verificar si el usuario tiene Multi-Origin (warehouse_management)
    var hasMultiOrigin = userInfo.tags && userInfo.tags.includes('warehouse_management');

    var scheduleData = null;

    // Si tiene Multi-Origin, intentar primero con el endpoint de nodos
    if (hasMultiOrigin) {
      console.log(account.name + ' - Usuario con Multi-Origin detectado, buscando nodos...');

      // Obtener los nodos del usuario
      var nodesUrl = 'https://api.mercadolibre.com/users/' + userId + '/shipping/warehouses';
      var nodesData = await mlApiRequest(account, nodesUrl);

      if (nodesData && Array.isArray(nodesData) && nodesData.length > 0) {
        // Usar el primer nodo activo
        var activeNode = nodesData.find(function(node) { return node.status === 'active'; }) || nodesData[0];
        if (activeNode && activeNode.id) {
          var nodeScheduleUrl = 'https://api.mercadolibre.com/nodes/' + activeNode.id + '/schedule/cross_docking';
          scheduleData = await mlApiRequest(account, nodeScheduleUrl);
          if (scheduleData) {
            console.log(account.name + ' - Schedule obtenido desde nodo: ' + activeNode.id);
          }
        }
      }
    }

    // Si no se obtuvo con nodos, intentar con USER_ID (método tradicional)
    if (!scheduleData) {
      var scheduleUrl = 'https://api.mercadolibre.com/users/' + userId + '/shipping/schedule/cross_docking';
      scheduleData = await mlApiRequest(account, scheduleUrl);
    }

    // Si aún no hay datos, intentar con xd_drop_off como alternativa
    if (!scheduleData) {
      var altScheduleUrl = 'https://api.mercadolibre.com/users/' + userId + '/shipping/schedule/xd_drop_off';
      scheduleData = await mlApiRequest(account, altScheduleUrl);
      if (scheduleData) {
        console.log(account.name + ' - Schedule obtenido desde xd_drop_off');
      }
    }

    if (!scheduleData) {
      console.log(account.name + ' - No se pudo obtener schedule de COLECTA');
      return null;
    }

    // Extraer cutoff - puede estar en diferentes estructuras
    var cutoff = null;

    // Estructura 1: monday.available_options
    if (scheduleData.monday && scheduleData.monday.available_options && scheduleData.monday.available_options.length > 0) {
      var selectedOption = scheduleData.monday.available_options.find(function(opt) { return opt.selected; });
      if (!selectedOption && scheduleData.monday.available_options.length > 0) {
        selectedOption = scheduleData.monday.available_options[0];
      }
      if (selectedOption && selectedOption.cutoff) {
        cutoff = selectedOption.cutoff;
      }
    }

    // Estructura 2: cutoff directo
    if (!cutoff && scheduleData.cutoff) {
      cutoff = scheduleData.cutoff;
    }

    // Estructura 3: default_cutoff
    if (!cutoff && scheduleData.default_cutoff) {
      cutoff = scheduleData.default_cutoff;
    }

    if (cutoff) {
      // cutoff viene en formato "HH:MM" (ej: "13:00")
      var parts = cutoff.split(':');
      if (parts.length === 2) {
        var minutos = parseInt(parts[0]) * 60 + parseInt(parts[1]);
        console.log(account.name + ' - Cutoff COLECTA obtenido: ' + cutoff);
        return minutos;
      }
    }

    return null;
  } catch (error) {
    console.error(account.name + ' - Error obteniendo cutoff COLECTA:', error.message);
    return null;
  }
}

async function getCutoffTimeDespacho(account) {
  // Obtiene el horario máximo de despacho en PUNTO DE DESPACHO (xd_drop_off) desde la API de ML
  if (!account.accessToken) return null;

  try {
    // Primero obtener el user ID
    var userInfo = await mlApiRequest(account, 'https://api.mercadolibre.com/users/me');
    if (!userInfo || !userInfo.id) {
      console.log(account.name + ' - No se pudo obtener user ID para horarios DESPACHO');
      return null;
    }
    var userId = userInfo.id;

    // Obtener processing time para xd_drop_off (con header X-Version: v3)
    var processingUrl = 'https://api.mercadolibre.com/shipping/users/' + userId + '/processing_time_middleend/xd_drop_off';

    var config = {
      headers: {
        'Authorization': 'Bearer ' + account.accessToken,
        'X-Version': 'v3'
      }
    };

    try {
      var response = await axios.get(processingUrl, config);
      var processingData = response.data;

      if (!processingData) {
        console.log(account.name + ' - No se pudo obtener processing time de DESPACHO');
        return null;
      }

      // El processing time puede tener diferentes días, usar monday como referencia
      var maximumTime = null;
      if (processingData.monday && processingData.monday.available_options && processingData.monday.available_options.length > 0) {
        var selectedOption = processingData.monday.available_options.find(function(opt) { return opt.selected; });
        if (!selectedOption && processingData.monday.available_options.length > 0) {
          selectedOption = processingData.monday.available_options[0];
        }
        if (selectedOption && selectedOption.maximum_time) {
          maximumTime = selectedOption.maximum_time;
        } else if (selectedOption && selectedOption.cutoff) {
          // Usar cutoff si no hay maximum_time
          maximumTime = selectedOption.cutoff;
        }
      }

      if (maximumTime) {
        // maximum_time viene en formato "HH:MM" (ej: "17:45")
        var parts = maximumTime.split(':');
        if (parts.length === 2) {
          var minutos = parseInt(parts[0]) * 60 + parseInt(parts[1]);
          console.log(account.name + ' - Horario máximo DESPACHO obtenido: ' + maximumTime);
          return minutos;
        }
      }
    } catch (apiError) {
      // Si falla con 401/403, intentar renovar token
      if (apiError.response && (apiError.response.status === 401 || apiError.response.status === 403)) {
        console.log('Token expirado para ' + account.name + ', intentando renovar...');
        var renewed = await refreshAccessToken(account);

        if (renewed) {
          config.headers['Authorization'] = 'Bearer ' + account.accessToken;
          try {
            var retryResponse = await axios.get(processingUrl, config);
            var retryData = retryResponse.data;

            if (retryData && retryData.monday && retryData.monday.available_options && retryData.monday.available_options.length > 0) {
              var selectedOption = retryData.monday.available_options.find(function(opt) { return opt.selected; });
              if (!selectedOption && retryData.monday.available_options.length > 0) {
                selectedOption = retryData.monday.available_options[0];
              }
              if (selectedOption && (selectedOption.maximum_time || selectedOption.cutoff)) {
                var time = selectedOption.maximum_time || selectedOption.cutoff;
                var parts = time.split(':');
                if (parts.length === 2) {
                  var minutos = parseInt(parts[0]) * 60 + parseInt(parts[1]);
                  console.log(account.name + ' - Horario máximo DESPACHO obtenido (retry): ' + time);
                  return minutos;
                }
              }
            }
          } catch (retryError) {
            console.error(account.name + ' - Error después de renovar token:', retryError.message);
          }
        }
      } else {
        console.error(account.name + ' - Error obteniendo processing time:', apiError.message);
      }
    }

    return null;
  } catch (error) {
    console.error(account.name + ' - Error obteniendo cutoff DESPACHO:', error.message);
    return null;
  }
}

async function loadHorariosFromAPI() {
  // Carga los horarios de corte desde la API de ML para todas las cuentas
  console.log('=== Cargando horarios desde API de ML ===');

  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    if (!account.accessToken) {
      console.log(account.name + ' - Sin token, saltando');
      continue;
    }

    console.log('Obteniendo horarios para cuenta: ' + account.name);

    // Obtener horario FLEX
    var flexCutoff = await getCutoffTimeFlex(account);
    if (flexCutoff !== null) {
      var key = account.name.toUpperCase() + '|flex';
      horariosCache[key] = flexCutoff;
      console.log('✓ ' + key + ' = ' + flexCutoff + ' minutos');
    }

    // Obtener horario COLECTA
    var colectaCutoff = await getCutoffTimeColecta(account);
    if (colectaCutoff !== null) {
      var key = account.name.toUpperCase() + '|colecta';
      horariosCache[key] = colectaCutoff;
      console.log('✓ ' + key + ' = ' + colectaCutoff + ' minutos');
    }

    // Obtener horario DESPACHO
    var despachoCutoff = await getCutoffTimeDespacho(account);
    if (despachoCutoff !== null) {
      var key = account.name.toUpperCase() + '|despacho';
      horariosCache[key] = despachoCutoff;
      console.log('✓ ' + key + ' = ' + despachoCutoff + ' minutos');
    }

    // Pequeña pausa entre cuentas para no saturar la API
    await new Promise(function(resolve) { setTimeout(resolve, 500); });
  }

  console.log('=== Horarios cargados desde API: ' + Object.keys(horariosCache).length + ' configuraciones ===');

  // Si no se cargó ningún horario desde la API, usar Sheets como fallback
  if (Object.keys(horariosCache).length === 0) {
    console.log('No se cargaron horarios desde API, intentando fallback a Sheets...');
    await loadHorariosFromSheets();
    console.log('Horarios cargados desde Sheets (fallback): ' + Object.keys(horariosCache).length + ' configuraciones');
  }
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

function isTodayOrder(dateCreated) {
  // Verifica si la orden es de hoy (comparando solo la fecha)
  var orderDate = getArgentinaDate(new Date(dateCreated));
  var today = getArgentinaTime();
  return orderDate.toLocaleDateString('es-AR') === today.toLocaleDateString('es-AR');
}

function isYesterday(dateCreated) {
  // Verifica si la orden es de ayer
  var orderDate = getArgentinaDate(new Date(dateCreated));
  var today = getArgentinaTime();
  var yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return orderDate.toLocaleDateString('es-AR') === yesterday.toLocaleDateString('es-AR');
}

function shouldProcessOrder(dateCreated, cuenta, logisticType) {
  // Determina si un envío corresponde al día de trabajo actual según su corte específico:
  // - Usa el horario de corte de la cuenta y tipo de logística del envío
  // - Órdenes de AYER creadas DESPUÉS del corte → entran hoy
  // - Órdenes de HOY creadas ANTES del corte → entran hoy
  // - Órdenes de HOY creadas DESPUÉS del corte → NO entran (corresponden a mañana)

  var orderDate = getArgentinaDate(new Date(dateCreated));
  var orderTimeInMinutes = orderDate.getHours() * 60 + orderDate.getMinutes();
  var corte = getHorarioCorte(cuenta, logisticType);

  if (isTodayOrder(dateCreated)) {
    return orderTimeInMinutes < corte;
  }
  if (isYesterday(dateCreated)) {
    return orderTimeInMinutes >= corte;
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

    pendingShipments.push({
      id: shippingId,
      orderId: shipmentInfo.orderIds.join(','), // Múltiples order_ids separados por coma
      orderIds: shipmentInfo.orderIds, // Array de order_ids para uso interno
      packId: shipmentInfo.packId,
      account: account.name,
      dateCreated: shipmentInfo.dateCreated,
      receiverName: shipment.receiver_address ? shipment.receiver_address.receiver_name : 'N/A',
      logisticType: shipment.logistic_type || '',
      status: status,
      mode: shipment.mode || ''
    });
  }

  console.log(account.name + ' - Envíos pendientes: ' + pendingShipments.length);

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
          range: sheetName + '!A1:J1',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [['Fecha', 'Hora', 'Envio', 'Cuenta', 'Receptor', 'SKUs', 'Estado', 'HoraVerif', 'Metodo', 'TipoLogistica']]
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

    // Limpiar contenido (excepto encabezados) - todas las columnas A-J
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A2:J1000'
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

      return [fecha, hora, s.id, s.account, s.receiverName, '', 'Pendiente', '', '', s.logisticType || ''];
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:J',
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
      range: sheetName + '!A:J'
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
      // Append nueva fila con todas las 10 columnas (A-J)
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: sheetName + '!A:J',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[fecha, hora, shipmentId, '', '', itemsStr, 'Verificado', hora, metodoStr, '']] }
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
      range: sheetName + '!A:J'
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

  // Cargar horarios de corte desde API de ML (una vez al día)
  if (lastHorariosLoadDate !== today) {
    console.log('=== Cargando horarios de corte desde API de ML ===');
    try {
      await loadHorariosFromAPI();
      lastHorariosLoadDate = today;
    } catch (error) {
      console.error('Error cargando horarios:', error.message);
    }
  }

  console.log('=== SINCRONIZACIÓN MATUTINA 9:00 AM ===');

  var sheetName = getTodaySheetName();

  // NO limpiar la hoja - preservar estados de verificación existentes
  await ensureDaySheetExists(sheetName);

  // Obtener IDs existentes para no duplicar y preservar sus estados
  var existingIds = await getExistingShipmentIds(sheetName);
  console.log('Envíos existentes en hoja: ' + existingIds.length);

  var allShipments = [];

  for (var i = 0; i < accounts.length; i++) {
    var shipments = await getReadyToShipOrders(accounts[i]);

    // Filtrar: solo los creados antes del corte horario de hoy o de días anteriores
    var filtered = shipments.filter(function(s) {
      return shouldProcessOrder(s.dateCreated, s.account, s.logisticType);
    });

    allShipments = allShipments.concat(filtered);
  }

  // Solo agregar envíos nuevos (addPendingShipments ya filtra duplicados)
  if (allShipments.length > 0) {
    await addPendingShipments(allShipments, sheetName);
  }

  lastMorningSyncDate = today;
  console.log('Sync matutino completado. Total desde ML: ' + allShipments.length + ', existentes preservados: ' + existingIds.length);
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

// ============================================
// GOOGLE VISION API - OCR Y DETECCIÓN DE COLOR
// ============================================

// Función para limpiar texto OCR (conservadora - mantiene letras)
function cleanOCRText(text) {
  if (!text) return '';

  return text
    .toUpperCase()
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[|]/g, 'I')      // | siempre es I
    .replace(/[^A-Z0-9\s\-\.]/g, '');
}

// Función para normalizar un SKU específico (corrige según contexto)
function normalizeSKU(sku) {
  if (!sku) return '';

  var normalized = sku.toUpperCase().trim();

  // Si tiene formato LETRA+NÚMEROS (A16, B22), mantener la letra
  if (/^[A-Z][0-9]+$/.test(normalized)) {
    return normalized; // Ya está bien
  }

  // Corregir 0 al inicio -> probablemente es O (letra)
  if (/^0[0-9]+$/.test(normalized)) {
    normalized = 'O' + normalized.substring(1);
  }

  // Corregir O entre números -> probablemente es 0
  normalized = normalized.replace(/([0-9])O([0-9])/g, '$10$2');
  normalized = normalized.replace(/([0-9])O$/g, '$10');

  // Corregir I/l entre números -> probablemente es 1
  normalized = normalized.replace(/([0-9])[Il]([0-9])/g, '$11$2');
  normalized = normalized.replace(/([0-9])[Il]$/g, '$11');

  return normalized;
}

// Función para extraer posibles SKUs (optimizada para códigos tipo A25, A36)
function extractPossibleSKUs(text, words) {
  var skuPatterns = [];

  var allText = (text + ' ' + words.join(' ')).toUpperCase();

  // Palabras comunes a ignorar (no son SKUs)
  var ignoreWords = [
    'FOR', 'NEW', 'CASE', 'PHONE', 'GOOD', 'QUALITY', 'FASHION', 'MOBILE',
    'COVER', 'PRODUCTS', 'MADE', 'CHINA', 'IN', 'THE', 'AND', 'PRO', 'MAX',
    '4G', '5G', 'LTE', 'SX', 'FT'  // Prefijos comunes de modelos
  ];

  // Patrón principal: 1 letra + 2-3 números (A25, A36, B22)
  // Este es el formato más probable de SKU
  var primaryMatches = allText.match(/\b[A-Z][0-9]{2,3}\b/g) || [];
  primaryMatches.forEach(function(match) {
    var normalized = normalizeSKU(match);
    if (!ignoreWords.includes(normalized)) {
      skuPatterns.push(normalized);
    }
  });

  // Si no encontró con el patrón principal, buscar más amplio
  if (skuPatterns.length === 0) {
    var secondaryMatches = allText.match(/[A-Z]{1,2}[0-9]{1,3}/g) || [];
    secondaryMatches.forEach(function(match) {
      var normalized = normalizeSKU(match);
      if (!ignoreWords.includes(normalized) && normalized.length >= 2) {
        skuPatterns.push(normalized);
      }
    });
  }

  // Filtrar duplicados
  var unique = [...new Set(skuPatterns)];

  // Priorizar: 1 letra + 2 números primero (A25 antes que AB12)
  unique.sort(function(a, b) {
    var aIsPerfect = /^[A-Z][0-9]{2}$/.test(a);  // A25
    var bIsPerfect = /^[A-Z][0-9]{2}$/.test(b);
    if (aIsPerfect && !bIsPerfect) return -1;
    if (!aIsPerfect && bIsPerfect) return 1;
    return a.length - b.length;
  });

  return unique;
}

// Función para determinar el color dominante del PRODUCTO (no del fondo)
function getDominantProductColor(colors) {
  if (!colors || colors.length === 0) return null;

  // Filtrar colores que probablemente son fondo
  var productColors = colors.filter(function(c) {
    var rgb = c.color || c;
    var r = rgb.red || 0;
    var g = rgb.green || 0;
    var b = rgb.blue || 0;

    // Calcular luminosidad
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b);

    // Calcular saturación aproximada
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var saturation = max === 0 ? 0 : (max - min) / max;

    // Filtrar:
    // - Colores muy claros (fondo blanco) - luminance > 240
    // - Colores muy oscuros (fondo negro) - luminance < 15
    // - Colores grises (baja saturación y luminancia media)
    var isBackground = (luminance > 240) ||
                       (luminance < 15) ||
                       (saturation < 0.1 && luminance > 100 && luminance < 200);

    return !isBackground;
  });

  // Si no quedó ninguno, usar el de mayor score (excluyendo blancos puros)
  if (productColors.length === 0) {
    productColors = colors.filter(function(c) {
      var rgb = c.color || c;
      var luminance = (0.299 * (rgb.red || 0) + 0.587 * (rgb.green || 0) + 0.114 * (rgb.blue || 0));
      return luminance < 250; // Excluir solo blancos muy puros
    });
  }

  // Retornar el color con mayor score entre los filtrados
  if (productColors.length === 0) return colors[0]; // Fallback al primero

  return productColors.reduce(function(best, current) {
    return (current.score || 0) > (best.score || 0) ? current : best;
  }, productColors[0]);
}

app.post('/api/vision/analyze', async function(req, res) {
  if (!vision) {
    return res.status(500).json({ error: 'Vision API no configurada' });
  }

  var imageBase64 = req.body.image; // Imagen en base64 (sin el prefijo data:image/...)
  if (!imageBase64) {
    return res.status(400).json({ error: 'No se recibio imagen' });
  }

  // Remover prefijo data:image si existe
  if (imageBase64.includes('base64,')) {
    imageBase64 = imageBase64.split('base64,')[1];
  }

  try {
    var response = await vision.images.annotate({
      requestBody: {
        requests: [{
          image: { content: imageBase64 },
          features: [
            { type: 'TEXT_DETECTION', maxResults: 10 },
            { type: 'IMAGE_PROPERTIES', maxResults: 10 }
          ]
        }]
      }
    });

    var result = response.data.responses[0];
    var textAnnotations = result.textAnnotations || [];
    var imageProperties = result.imagePropertiesAnnotation || {};

    // Extraer texto detectado
    var rawText = textAnnotations.length > 0 ? textAnnotations[0].description : '';
    var words = textAnnotations.slice(1).map(function(t) { return t.description; });

    // Texto limpio (convertido a números donde hay ambigüedad)
    var cleanedText = cleanOCRText(rawText);

    // Posibles SKUs extraídos
    var possibleSKUs = extractPossibleSKUs(rawText, words);

    // Extraer colores dominantes
    var allColors = [];
    if (imageProperties.dominantColors && imageProperties.dominantColors.colors) {
      allColors = imageProperties.dominantColors.colors.map(function(c) {
        var rgb = c.color;
        return {
          red: rgb.red || 0,
          green: rgb.green || 0,
          blue: rgb.blue || 0,
          score: c.score,
          pixelFraction: c.pixelFraction,
          color: c.color,
          name: getColorName(rgb.red || 0, rgb.green || 0, rgb.blue || 0)
        };
      });
    }

    // Obtener el color dominante del producto (no del fondo)
    var dominantProductColor = getDominantProductColor(allColors);
    var mainColor = dominantProductColor ? {
      name: getColorName(dominantProductColor.red || (dominantProductColor.color && dominantProductColor.color.red) || 0,
                         dominantProductColor.green || (dominantProductColor.color && dominantProductColor.color.green) || 0,
                         dominantProductColor.blue || (dominantProductColor.color && dominantProductColor.color.blue) || 0),
      rgb: {
        red: dominantProductColor.red || (dominantProductColor.color && dominantProductColor.color.red) || 0,
        green: dominantProductColor.green || (dominantProductColor.color && dominantProductColor.color.green) || 0,
        blue: dominantProductColor.blue || (dominantProductColor.color && dominantProductColor.color.blue) || 0
      },
      score: dominantProductColor.score,
      pixelFraction: dominantProductColor.pixelFraction
    } : null;

    res.json({
      success: true,
      // Texto original
      rawText: rawText,
      // Texto limpio (para códigos/SKUs)
      text: cleanedText,
      // Palabras individuales
      words: words,
      // Posibles SKUs detectados
      possibleSKUs: possibleSKUs,
      // Color principal del producto
      mainColor: mainColor,
      // Todos los colores (para debug)
      allColors: allColors.slice(0, 5)
    });

  } catch (error) {
    console.error('Error en Vision API:', error.message);
    res.status(500).json({ error: 'Error procesando imagen: ' + error.message });
  }
});

// Función para nombrar colores básicos (optimizada para fundas de celular)
function getColorName(r, g, b) {
  var colors = {
    'Negro': { r: 0, g: 0, b: 0 },
    'Blanco': { r: 255, g: 255, b: 255 },
    'Rojo': { r: 255, g: 0, b: 0 },
    'Verde': { r: 0, g: 200, b: 0 },
    'Verde Oscuro': { r: 0, g: 100, b: 0 },
    'Azul': { r: 0, g: 0, b: 255 },
    'Azul Marino': { r: 0, g: 0, b: 128 },
    'Amarillo': { r: 255, g: 255, b: 0 },
    'Rosa': { r: 255, g: 105, b: 180 },
    'Rosa Claro': { r: 255, g: 182, b: 193 },
    'Lila': { r: 200, g: 162, b: 200 },
    'Lavanda': { r: 230, g: 190, b: 230 },
    'Naranja': { r: 255, g: 165, b: 0 },
    'Morado': { r: 128, g: 0, b: 128 },
    'Violeta': { r: 148, g: 0, b: 211 },
    'Celeste': { r: 135, g: 206, b: 235 },
    'Gris': { r: 128, g: 128, b: 128 },
    'Gris Oscuro': { r: 64, g: 64, b: 64 },
    'Marron': { r: 139, g: 69, b: 19 },
    'Beige': { r: 245, g: 245, b: 220 },
    'Turquesa': { r: 64, g: 224, b: 208 },
    'Coral': { r: 255, g: 127, b: 80 },
    'Bordo': { r: 128, g: 0, b: 32 },
    'Transparente': { r: 250, g: 250, b: 250 }
  };

  var minDistance = Infinity;
  var closestColor = 'Desconocido';

  for (var name in colors) {
    var c = colors[name];
    var distance = Math.sqrt(
      Math.pow(r - c.r, 2) +
      Math.pow(g - c.g, 2) +
      Math.pow(b - c.b, 2)
    );
    if (distance < minDistance) {
      minDistance = distance;
      closestColor = name;
    }
  }

  return closestColor;
}

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
      range: sheetName + '!A:J'
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
      orderId: allOrderIds.join(','), // Múltiples order_ids separados por coma
      orderIds: allOrderIds, // Array de order_ids
      packId: packId,
      account: account.name,
      dateCreated: dateCreated,
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

// Recargar horarios desde Sheets (fallback/manual)
app.post('/api/horarios/reload', async function(req, res) {
  await loadHorariosFromSheets();
  res.json({ success: true, horarios: horariosCache, fuente: 'sheets' });
});

// Recargar horarios desde API de ML
app.post('/api/horarios/refresh', async function(req, res) {
  try {
    await loadHorariosFromAPI();
    res.json({
      success: true,
      mensaje: 'Horarios actualizados desde API de ML',
      horarios: horariosCache,
      count: Object.keys(horariosCache).length
    });
  } catch (error) {
    console.error('Error refrescando horarios:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
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

    // Leer datos de la hoja del día (todas las columnas A-J)
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:J'
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
      range: sheetName + '!A:J'
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
      range: sheetName + '!A:J'
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

    // Leer todos los envíos de la hoja (todas las columnas A-J)
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:J'
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

    // Intentar cargar horarios desde API de ML (fuente principal)
    try {
      await loadHorariosFromAPI();
      console.log('✓ Horarios cargados desde API de ML');
    } catch (apiError) {
      console.error('Error cargando horarios desde API, usando Sheets como fallback:', apiError.message);
      // Fallback: cargar desde Sheets si la API falla
      await loadHorariosFromSheets();
      console.log('✓ Horarios cargados desde Google Sheets (fallback)');
    }

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
