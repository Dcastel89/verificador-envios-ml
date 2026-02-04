/**
 * Script para enriquecer los registros existentes de Errores_SKU
 * agregando el ID de MercadoLibre (item_id) a cada registro
 */
require('dotenv').config();
const { google } = require('googleapis');
const https = require('https');

// Configuración de Google Sheets
const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Tokens de las cuentas (se cargan de Sheets)
const ACCOUNTS = {};

// Cargar tokens desde Google Sheets (igual que server.js)
async function loadTokensFromSheets() {
  console.log('Cargando tokens desde Google Sheets...');

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Tokens!A:D'
    });

    const rows = response.data.values || [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0]) continue;

      const accountName = row[0].toUpperCase();
      const accessToken = row[1];

      if (accessToken) {
        ACCOUNTS[accountName] = { accessToken };
        console.log(`  Token cargado para ${accountName}`);
      }
    }
  } catch (error) {
    console.error('Error cargando tokens:', error.message);
  }
}

// Función para hacer request a la API de MercadoLibre
function mlRequest(path, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.mercadolibre.com',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Obtener item_id de un envío usando el endpoint /shipments/{id}/items
async function getItemIdFromShipment(shipmentId, sku, cuenta) {
  const account = ACCOUNTS[cuenta];
  if (!account || !account.accessToken) {
    console.log(`  No hay token para la cuenta ${cuenta}`);
    return null;
  }

  try {
    // Usar el endpoint /shipments/{id}/items que devuelve los items del envío directamente
    const itemsResponse = await mlRequest(
      `/shipments/${shipmentId}/items`,
      account.accessToken
    );

    if (!itemsResponse || itemsResponse.error) {
      console.log(`  Error API: ${itemsResponse?.message || itemsResponse?.error || 'desconocido'}`);
      return null;
    }

    if (!Array.isArray(itemsResponse) || itemsResponse.length === 0) {
      console.log(`  Sin items en el envío`);
      return null;
    }

    // Si solo hay un item, usarlo directamente
    if (itemsResponse.length === 1) {
      const item = itemsResponse[0];
      return item.item_id + (item.variation_id ? '-' + item.variation_id : '');
    }

    // Si hay múltiples items, buscar el que coincida con el SKU
    for (const item of itemsResponse) {
      const itemId = item.item_id;
      if (!itemId) continue;

      // Obtener detalles del item para verificar el SKU
      const itemDetails = await mlRequest('/items/' + itemId, account.accessToken);

      if (itemDetails && !itemDetails.error) {
        // Verificar seller_custom_field
        if (itemDetails.seller_custom_field === sku) {
          return itemId + (item.variation_id ? '-' + item.variation_id : '');
        }

        // Verificar en atributos SELLER_SKU
        if (itemDetails.attributes) {
          const skuAttr = itemDetails.attributes.find(a => a.id === 'SELLER_SKU');
          if (skuAttr && skuAttr.value_name === sku) {
            return itemId + (item.variation_id ? '-' + item.variation_id : '');
          }
        }

        // Si tiene variaciones, buscar en ellas
        if (item.variation_id && itemDetails.variations) {
          const variation = itemDetails.variations.find(v => v.id === item.variation_id);
          if (variation && variation.attributes) {
            const varSkuAttr = variation.attributes.find(a => a.id === 'SELLER_SKU');
            if (varSkuAttr && varSkuAttr.value_name === sku) {
              return itemId + '-' + item.variation_id;
            }
          }
        }
      }

      // Pequeña pausa entre requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Si no encontró match exacto, devolver el primer item
    const firstItem = itemsResponse[0];
    return firstItem.item_id + (firstItem.variation_id ? '-' + firstItem.variation_id : '');

  } catch (error) {
    console.log(`  Error: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('=== Enriqueciendo registros de Errores_SKU ===\n');

  // Cargar tokens primero
  await loadTokensFromSheets();
  console.log('');

  try {
    // 1. Leer todos los registros actuales
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Errores_SKU!A:H'
    });

    const rows = response.data.values || [];

    if (rows.length === 0) {
      console.log('La hoja está vacía');
      return;
    }

    console.log(`Total de filas: ${rows.length}\n`);

    // 2. Verificar si ya existe la columna ID_ML
    const headers = rows[0];
    let idMlColIndex = headers.indexOf('ID_ML');

    if (idMlColIndex === -1) {
      // Agregar encabezado ID_ML
      console.log('Agregando columna ID_ML...');
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Errores_SKU!H1',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [['ID_ML']] }
      });
      idMlColIndex = 7; // Columna H (índice 7)
      console.log('Columna ID_ML agregada\n');
    }

    // 3. Procesar cada fila que no tenga ID_ML
    let actualizados = 0;
    let errores = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const sku = row[2];        // Columna C
      const envioId = row[5];    // Columna F
      const cuenta = row[6];     // Columna G
      const existingIdMl = row[7]; // Columna H

      // Si ya tiene ID_ML, saltar
      if (existingIdMl) {
        console.log(`Fila ${i + 1}: Ya tiene ID_ML (${existingIdMl})`);
        continue;
      }

      // Si no tiene envioId, no podemos buscar
      if (!envioId) {
        console.log(`Fila ${i + 1}: Sin envío ID, no se puede buscar`);
        errores++;
        continue;
      }

      console.log(`Fila ${i + 1}: Buscando ID_ML para SKU "${sku}" en envío ${envioId} (${cuenta})...`);

      const itemId = await getItemIdFromShipment(envioId, sku, cuenta);

      if (itemId) {
        // Actualizar la celda
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Errores_SKU!H${i + 1}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [[itemId]] }
        });
        console.log(`  -> ID_ML: ${itemId}`);
        actualizados++;
      } else {
        console.log(`  -> No se encontró ID_ML`);
        errores++;
      }

      // Esperar un poco para no saturar la API
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log('\n=== Resumen ===');
    console.log(`Registros actualizados: ${actualizados}`);
    console.log(`Registros sin ID_ML: ${errores}`);

  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
