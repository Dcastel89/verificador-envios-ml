// ============================================
// MÓDULO DE BARCODE-SKU
// ============================================
// Maneja el mapeo entre códigos de barras/rotuladora y SKUs
// Usa Google Sheets como persistencia y cache en memoria

var express = require('express');
var router = express.Router();

// Referencias a Google Sheets (se configuran desde server.js)
var sheets = null;
var SHEET_ID = null;
var requireAuthFn = null;

// Cache en memoria para mapeo barcode -> SKU
var barcodeCache = {};

// ============================================
// CONFIGURACIÓN - Se llama desde server.js
// ============================================

function configure(sheetsClient, sheetId, requireAuth) {
  sheets = sheetsClient;
  SHEET_ID = sheetId;
  requireAuthFn = requireAuth;
  console.log('Barcodes: Configurado con Google Sheets');
}

// ============================================
// FUNCIONES DE DATOS
// ============================================

async function loadBarcodesFromSheets() {
  if (!sheets || !SHEET_ID) {
    console.log('Sheets no configurado, no se pueden cargar barcodes');
    return;
  }

  barcodeCache = {};

  // Cargar desde pestaña Barcodes
  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Barcodes!A:C'
    });

    var rows = response.data.values || [];
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0] || !row[1]) continue;
      var barcode = row[0].toString().trim();
      var sku = row[1].toString().trim();
      barcodeCache[barcode] = sku;
    }
    console.log('Cargados ' + (rows.length - 1) + ' códigos de Barcodes');
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      console.log('Hoja Barcodes no existe, creándola...');
      await createBarcodesSheet();
    } else {
      console.error('Error cargando Barcodes:', error.message);
    }
  }

  // Cargar desde pestaña Rotuladora
  try {
    var response2 = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Rotuladora!A:B'
    });

    var rows2 = response2.data.values || [];
    for (var i = 1; i < rows2.length; i++) {
      var row = rows2[i];
      if (!row[0] || !row[1]) continue;
      var codigo = row[0].toString().trim();
      var sku = row[1].toString().trim();
      barcodeCache[codigo] = sku;
    }
    console.log('Cargados ' + (rows2.length - 1) + ' códigos de Rotuladora');
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      console.log('Hoja Rotuladora no existe (se creará cuando agregues datos)');
    } else {
      console.error('Error cargando Rotuladora:', error.message);
    }
  }

  console.log('Total códigos en cache: ' + Object.keys(barcodeCache).length);
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
// ENDPOINTS
// ============================================

// Obtener SKU por código de barras
router.get('/api/barcode/:barcode', function(req, res) {
  var barcode = req.params.barcode.trim();
  var sku = getSkuByBarcode(barcode);

  if (sku) {
    res.json({ barcode: barcode, sku: sku, found: true });
  } else {
    res.json({ barcode: barcode, sku: null, found: false });
  }
});

// Guardar mapeo barcode-SKU
router.post('/api/barcode', async function(req, res) {
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
router.get('/api/barcodes', function(req, res) {
  var mappings = [];
  for (var barcode in barcodeCache) {
    mappings.push({ barcode: barcode, sku: barcodeCache[barcode] });
  }
  res.json({ mappings: mappings, count: mappings.length });
});

// Recargar mapeos desde Sheets
router.post('/api/barcodes/reload', async function(req, res) {
  await loadBarcodesFromSheets();
  res.json({ success: true, count: Object.keys(barcodeCache).length });
});

// Importar códigos de rotuladora en lote
router.post('/api/barcodes/import', function(req, res, next) {
  // Usar requireAuth pasado por configure
  if (requireAuthFn) {
    requireAuthFn(req, res, next);
  } else {
    next();
  }
}, async function(req, res) {
  var codigos = req.body.codigos; // Array de { codigo, sku }
  if (!codigos || !Array.isArray(codigos)) {
    return res.status(400).json({ error: 'Se requiere array de codigos' });
  }

  if (!sheets || !SHEET_ID) {
    return res.status(500).json({ error: 'Sheets no configurado' });
  }

  try {
    // Preparar filas para agregar
    var rows = codigos.map(function(c) {
      return [c.codigo, c.sku, 'Rotuladora'];
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Barcodes!A:C',
      valueInputOption: 'RAW',
      resource: { values: rows }
    });

    // Actualizar cache local
    codigos.forEach(function(c) {
      barcodeCache[c.codigo] = c.sku;
    });

    res.json({ success: true, imported: codigos.length });
  } catch (error) {
    console.error('Error importando códigos:', error.message);
    res.status(500).json({ error: 'Error importando: ' + error.message });
  }
});

// ============================================
// EXPORTS
// ============================================

module.exports = router;
module.exports.configure = configure;
module.exports.loadBarcodesFromSheets = loadBarcodesFromSheets;
module.exports.getSkuByBarcode = getSkuByBarcode;
