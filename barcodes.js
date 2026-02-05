// ============================================
// MÓDULO DE BARCODE-SKU
// ============================================
// Maneja el mapeo entre códigos de barras/rotuladora y SKUs
// Usa Google Sheets como persistencia y cache en memoria

var express = require('express');
var router = express.Router();
var fs = require('fs');
var path = require('path');

// Prompts config para devolver instrucciones por SKU
var prompts = require('./prompts');

// Referencias a Google Sheets (se configuran desde server.js)
var sheets = null;
var SHEET_ID = null;
var requireAuthFn = null;

// Cache en memoria para mapeo barcode -> SKU
var barcodeCache = {};

// Normaliza barcodes que Sheets pudo convertir a notación científica (ej: 7.89123E+12 -> 7891230000000)
function normalizeBarcode(value) {
  var str = value.toString().trim();
  // Si tiene E+ o e+ es notación científica, convertir al número entero
  if (/[eE]\+/.test(str)) {
    try {
      var num = Number(str);
      if (!isNaN(num) && isFinite(num)) {
        return num.toFixed(0);
      }
    } catch (e) {}
  }
  return str;
}

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
    var fixed = 0;
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0] || !row[1]) continue;
      var barcode = normalizeBarcode(row[0]);
      var sku = row[1].toString().trim();
      if (barcode !== row[0].toString().trim()) fixed++;
      barcodeCache[barcode] = sku;
    }
    console.log('Cargados ' + (rows.length - 1) + ' códigos de Barcodes' + (fixed ? ' (' + fixed + ' corregidos de notación científica)' : ''));
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
    var fixed2 = 0;
    for (var i = 1; i < rows2.length; i++) {
      var row = rows2[i];
      if (!row[0] || !row[1]) continue;
      var codigo = normalizeBarcode(row[0]);
      var sku = row[1].toString().trim();
      if (codigo !== row[0].toString().trim()) fixed2++;
      barcodeCache[codigo] = sku;
    }
    console.log('Cargados ' + (rows2.length - 1) + ' códigos de Rotuladora' + (fixed2 ? ' (' + fixed2 + ' corregidos de notación científica)' : ''));
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      console.log('Hoja Rotuladora no existe (se creará cuando agregues datos)');
    } else {
      console.error('Error cargando Rotuladora:', error.message);
    }
  }

  // Cargar códigos de fábrica desde archivo local
  try {
    var fabricaPath = path.join(__dirname, 'codigos_fabrica.json');
    if (fs.existsSync(fabricaPath)) {
      var fabricaData = JSON.parse(fs.readFileSync(fabricaPath, 'utf8'));
      var fabricaCount = 0;
      for (var barcode in fabricaData) {
        // Archivo de fábrica tiene prioridad (datos correctos del Excel)
        barcodeCache[barcode] = fabricaData[barcode];
        fabricaCount++;
      }
      console.log('Cargados ' + fabricaCount + ' códigos de fábrica (sobreescriben Sheets)');
    }
  } catch (error) {
    console.error('Error cargando códigos de fábrica:', error.message);
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
      // Agregar nuevo (RAW para que Sheets no convierta barcodes a notación científica)
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Barcodes!A:C',
        valueInputOption: 'RAW',
        resource: {
          values: [[barcode, sku, description || '']]
        }
      });
    } else {
      // Actualizar existente
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Barcodes!A' + rowIndex + ':C' + rowIndex,
        valueInputOption: 'RAW',
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
  // Búsqueda exacta primero
  if (barcodeCache[barcode]) return barcodeCache[barcode];

  // Si tiene 13 dígitos y empieza con 0, probar sin el cero (por si Sheets lo truncó)
  if (barcode.length === 13 && barcode.charAt(0) === '0') {
    var sinCero = barcode.substring(1);
    if (barcodeCache[sinCero]) {
      console.log('Barcode: match sin cero inicial: ' + barcode + ' -> ' + sinCero);
      return barcodeCache[sinCero];
    }
  }

  // Si tiene 12 dígitos, probar con cero al inicio (EAN-13 con cero perdido)
  if (barcode.length === 12 && /^\d+$/.test(barcode)) {
    var conCero = '0' + barcode;
    if (barcodeCache[conCero]) {
      console.log('Barcode: match con cero inicial: ' + barcode + ' -> ' + conCero);
      return barcodeCache[conCero];
    }
  }

  return null;
}

// ============================================
// ENDPOINTS
// ============================================

// Obtener SKU por código de barras
router.get('/api/barcode/:barcode', function(req, res) {
  var barcode = req.params.barcode.trim();
  var sku = getSkuByBarcode(barcode);

  if (sku) {
    console.log('Barcode encontrado: ' + barcode + ' -> ' + sku);
    // Obtener config de prompts para este SKU
    var tipo = prompts.detectProductType(sku, '');
    var skuRule = null;
    var config = prompts.loadConfig();
    var skuRules = config.skuRules || {};
    var skuUpper = sku.toUpperCase();
    var ruleKeys = Object.keys(skuRules);
    for (var r = 0; r < ruleKeys.length; r++) {
      if (skuUpper.indexOf(ruleKeys[r].toUpperCase()) === 0) {
        skuRule = skuRules[ruleKeys[r]];
        break;
      }
    }
    // Merge tipo config con SKU rule
    var merged = Object.assign({}, tipo.config);
    if (skuRule) {
      for (var k in skuRule) {
        if (k !== 'nota') merged[k] = skuRule[k];
      }
      if (skuRule.nota) merged.nota = skuRule.nota;
    }
    var productConfig = {
      tipo: tipo.nombre,
      dondeVerificar: merged.dondeVerificar || null,
      reglaColor: merged.reglaColor || null,
      formatoModelo: merged.formatoModelo || null,
      notasExtra: merged.notasExtra || null,
      nota: merged.nota || null,
      mensajeFoto: merged.mensajeFoto || null
    };
    res.json({ barcode: barcode, sku: sku, found: true, productConfig: productConfig });
  } else {
    console.log('Barcode NO encontrado: "' + barcode + '" (cache tiene ' + Object.keys(barcodeCache).length + ' códigos)');
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

// Buscar barcodes por SKU (búsqueda parcial)
router.get('/api/barcodes/search', function(req, res) {
  var q = (req.query.q || '').toUpperCase().trim();
  if (!q) return res.json({ results: [] });
  var results = [];
  for (var barcode in barcodeCache) {
    var sku = barcodeCache[barcode];
    if (sku.toUpperCase().indexOf(q) !== -1) {
      results.push({ barcode: barcode, sku: sku });
    }
  }
  res.json({ results: results });
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
