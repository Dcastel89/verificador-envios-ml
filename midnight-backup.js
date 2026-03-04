// ============================================
// BACKUP NOCTURNO A POSTGRESQL
// ============================================
// Lee datos del día desde Google Sheets, los guarda en PostgreSQL
// y limpia las hojas. Se ejecuta a medianoche via cron.

var db = require('./db');

var sheets = null;
var ML_SHEET_ID = null;
var MAYORISTA_SHEET_ID = null;

var DAYS = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];

function configure(sheetsClient, mlSheetId, mayoristaSheetId) {
  sheets = sheetsClient;
  ML_SHEET_ID = mlSheetId;
  MAYORISTA_SHEET_ID = mayoristaSheetId;
}

// ============================================
// UTILIDADES
// ============================================

function getArgentinaTime() {
  var now = new Date();
  var argentinaOffset = -3 * 60;
  var localOffset = now.getTimezoneOffset();
  return new Date(now.getTime() + (localOffset + argentinaOffset) * 60000);
}

// Convierte DD/MM/YYYY a YYYY-MM-DD para PostgreSQL
function parseDateToISO(dateStr) {
  if (!dateStr) return null;
  var parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  var day = parts[0].padStart(2, '0');
  var month = parts[1].padStart(2, '0');
  return parts[2] + '-' + month + '-' + day;
}

function getYesterdayInfo() {
  var now = getArgentinaTime();
  var yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  var dayName = DAYS[yesterday.getDay()];
  var day = String(yesterday.getDate()).padStart(2, '0');
  var month = String(yesterday.getMonth() + 1).padStart(2, '0');
  var year = yesterday.getFullYear();
  var fechaStr = day + '/' + month + '/' + year;
  var fechaISO = year + '-' + month + '-' + day;

  return { dayName: dayName, fechaStr: fechaStr, fechaISO: fechaISO };
}

// ============================================
// LECTURA DESDE SHEETS
// ============================================

async function readSheet(spreadsheetId, range) {
  try {
    var response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: range
    });
    return response.data.values || [];
  } catch (error) {
    if (error.message && error.message.includes('Unable to parse range')) {
      return [];
    }
    throw error;
  }
}

async function clearSheet(spreadsheetId, range) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: spreadsheetId,
    range: range
  });
}

// ============================================
// INSERCIÓN EN POSTGRESQL
// ============================================

async function insertEnvios(rows, fechaISO) {
  if (rows.length === 0) return { ok: true, count: 0 };

  var client = await db.getClient();
  try {
    await client.query('BEGIN');

    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r[2]) continue; // sin envio_id, skip

      var fecha = parseDateToISO(r[0]) || fechaISO;
      await client.query(
        'INSERT INTO verificaciones_envios (fecha, hora, envio_id, cuenta, receptor, skus, estado, hora_verif, metodo, tipo_logistica, promesa, sla) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (fecha, envio_id) DO NOTHING',
        [fecha, r[1] || null, String(r[2]), r[3] || null, r[4] || null, r[5] || null,
         r[6] || null, r[7] || null, r[8] || null, r[9] || null, r[10] || null, r[11] || null]
      );
      count++;
    }

    await client.query('COMMIT');
    return { ok: true, count: count };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertMayorista(rows, fechaISO) {
  if (rows.length === 0) return { ok: true, count: 0 };

  var client = await db.getClient();
  try {
    await client.query('BEGIN');

    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r[2]) continue; // sin order_id, skip

      var fecha = parseDateToISO(r[0]) || fechaISO;
      await client.query(
        'INSERT INTO verificaciones_mayorista (fecha, hora, order_id, cuenta, cliente, items, estado, hora_verif, metodo, estado_verif, camino, timestamp_inicio, codigos_desconocidos) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (fecha, order_id) DO NOTHING',
        [fecha, r[1] || null, String(r[2]), r[3] || null, r[4] || null, r[5] || null,
         r[6] || null, r[7] || null, r[8] || null, r[9] || null, r[10] || null,
         r[11] || null, r[12] || null]
      );
      count++;
    }

    await client.query('COMMIT');
    return { ok: true, count: count };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertMayoristaItems(rows) {
  if (rows.length === 0) return { ok: true, count: 0 };

  var client = await db.getClient();
  try {
    await client.query('BEGIN');

    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r[1]) continue; // sin order_id, skip

      var fecha = parseDateToISO(r[0]);
      if (!fecha) continue;

      await client.query(
        'INSERT INTO verificaciones_mayorista_items (fecha, order_id, cuenta, sku, nombre, cantidad, verificados, metodo, ultima_verif, metodo_por_unidad, inconsistencia, resolucion_info) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [fecha, String(r[1]), r[2] || null, r[3] || null, r[4] || null,
         parseInt(r[5]) || 0, parseInt(r[6]) || 0, r[7] || null, r[8] || null,
         r[9] || null, r[10] || null, r[11] || null]
      );
      count++;
    }

    await client.query('COMMIT');
    return { ok: true, count: count };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertErroresSku(rows) {
  if (rows.length === 0) return { ok: true, count: 0 };

  var client = await db.getClient();
  try {
    await client.query('BEGIN');

    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var fecha = parseDateToISO(r[0]);
      if (!fecha) continue;

      await client.query(
        'INSERT INTO verificaciones_errores_sku (fecha, hora, sku, descripcion, nota, envio_id, cuenta, id_ml) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [fecha, r[1] || null, r[2] || null, r[3] || null, r[4] || null,
         r[5] || null, r[6] || null, r[7] || null]
      );
      count++;
    }

    await client.query('COMMIT');
    return { ok: true, count: count };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ============================================
// BACKUP PRINCIPAL
// ============================================

async function runMidnightBackup() {
  console.log('=== BACKUP NOCTURNO: Iniciando ===');

  if (!db.isConfigured()) {
    console.log('BACKUP: DATABASE_URL no configurada, saltando backup');
    return { skipped: true, reason: 'DATABASE_URL no configurada' };
  }

  if (!sheets) {
    console.log('BACKUP: Google Sheets no configurado, saltando backup');
    return { skipped: true, reason: 'Sheets no configurado' };
  }

  var yesterday = getYesterdayInfo();
  console.log('BACKUP: Procesando datos de ' + yesterday.dayName + ' (' + yesterday.fechaStr + ')');

  var results = {};

  // --- ENVÍOS ML ---
  try {
    var enviosSheet = 'Envios_' + yesterday.dayName;
    var enviosRows = await readSheet(ML_SHEET_ID, enviosSheet + '!A2:L1000');
    console.log('BACKUP: Envíos leídos: ' + enviosRows.length + ' filas');

    if (enviosRows.length > 0) {
      var enviosResult = await insertEnvios(enviosRows, yesterday.fechaISO);
      results.envios = { ok: true, read: enviosRows.length, inserted: enviosResult.count };
      console.log('BACKUP: Envíos insertados: ' + enviosResult.count);

      await clearSheet(ML_SHEET_ID, enviosSheet + '!A2:L1000');
      console.log('BACKUP: Hoja ' + enviosSheet + ' limpiada');
    } else {
      results.envios = { ok: true, read: 0, inserted: 0 };
    }
  } catch (error) {
    console.error('BACKUP ERROR envíos:', error.message);
    results.envios = { ok: false, error: error.message };
  }

  // --- MAYORISTA ÓRDENES ---
  try {
    var mayoristaSheet = 'Mayorista_' + yesterday.dayName;
    var mayoristaRows = await readSheet(MAYORISTA_SHEET_ID, mayoristaSheet + '!A2:M1000');
    console.log('BACKUP: Mayorista leídos: ' + mayoristaRows.length + ' filas');

    if (mayoristaRows.length > 0) {
      var mayoristaResult = await insertMayorista(mayoristaRows, yesterday.fechaISO);
      results.mayorista = { ok: true, read: mayoristaRows.length, inserted: mayoristaResult.count };
      console.log('BACKUP: Mayorista insertados: ' + mayoristaResult.count);

      await clearSheet(MAYORISTA_SHEET_ID, mayoristaSheet + '!A2:M1000');
      console.log('BACKUP: Hoja ' + mayoristaSheet + ' limpiada');
    } else {
      results.mayorista = { ok: true, read: 0, inserted: 0 };
    }
  } catch (error) {
    console.error('BACKUP ERROR mayorista:', error.message);
    results.mayorista = { ok: false, error: error.message };
  }

  // --- MAYORISTA ITEMS (filtrado por fecha de ayer) ---
  try {
    var allItems = await readSheet(MAYORISTA_SHEET_ID, 'Mayorista_Items!A2:L5000');
    var yesterdayItems = allItems.filter(function(row) {
      return row[0] === yesterday.fechaStr;
    });
    console.log('BACKUP: Mayorista Items del día: ' + yesterdayItems.length + ' de ' + allItems.length + ' total');

    if (yesterdayItems.length > 0) {
      var itemsResult = await insertMayoristaItems(yesterdayItems);
      results.mayoristaItems = { ok: true, read: yesterdayItems.length, inserted: itemsResult.count };
      console.log('BACKUP: Mayorista Items insertados: ' + itemsResult.count);

      // Reescribir solo las filas que NO son de ayer
      var remainingItems = allItems.filter(function(row) {
        return row[0] !== yesterday.fechaStr;
      });

      await clearSheet(MAYORISTA_SHEET_ID, 'Mayorista_Items!A2:L5000');

      if (remainingItems.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: MAYORISTA_SHEET_ID,
          range: 'Mayorista_Items!A2:L' + (remainingItems.length + 1),
          valueInputOption: 'RAW',
          resource: { values: remainingItems }
        });
      }
      console.log('BACKUP: Mayorista Items limpiados (quedan ' + remainingItems.length + ' de otros días)');
    } else {
      results.mayoristaItems = { ok: true, read: 0, inserted: 0 };
    }
  } catch (error) {
    console.error('BACKUP ERROR mayorista items:', error.message);
    results.mayoristaItems = { ok: false, error: error.message };
  }

  // --- ERRORES SKU (filtrado por fecha de ayer) ---
  try {
    var allErrors = await readSheet(ML_SHEET_ID, 'Errores_SKU!A2:H5000');
    var yesterdayErrors = allErrors.filter(function(row) {
      return row[0] === yesterday.fechaStr;
    });
    console.log('BACKUP: Errores SKU del día: ' + yesterdayErrors.length + ' de ' + allErrors.length + ' total');

    if (yesterdayErrors.length > 0) {
      var errorsResult = await insertErroresSku(yesterdayErrors);
      results.erroresSku = { ok: true, read: yesterdayErrors.length, inserted: errorsResult.count };
      console.log('BACKUP: Errores SKU insertados: ' + errorsResult.count);

      // Reescribir solo las filas que NO son de ayer
      var remainingErrors = allErrors.filter(function(row) {
        return row[0] !== yesterday.fechaStr;
      });

      await clearSheet(ML_SHEET_ID, 'Errores_SKU!A2:H5000');

      if (remainingErrors.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: ML_SHEET_ID,
          range: 'Errores_SKU!A2:H' + (remainingErrors.length + 1),
          valueInputOption: 'RAW',
          resource: { values: remainingErrors }
        });
      }
      console.log('BACKUP: Errores SKU limpiados (quedan ' + remainingErrors.length + ' de otros días)');
    } else {
      results.erroresSku = { ok: true, read: 0, inserted: 0 };
    }
  } catch (error) {
    console.error('BACKUP ERROR errores sku:', error.message);
    results.erroresSku = { ok: false, error: error.message };
  }

  console.log('=== BACKUP NOCTURNO: Finalizado ===');
  console.log('Resultados:', JSON.stringify(results));
  return results;
}

module.exports = {
  configure: configure,
  runMidnightBackup: runMidnightBackup
};
