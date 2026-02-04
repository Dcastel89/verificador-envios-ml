// Script para importar códigos de rotuladora a Google Sheets
// Ejecutar una vez: node import-codigos-rotuladora.js

const fs = require('fs');
const path = require('path');

// Leer el archivo JSON generado del Excel
const codigosPath = path.join(__dirname, 'codigos_rotuladora.json');

if (!fs.existsSync(codigosPath)) {
  console.error('No se encontró el archivo codigos_rotuladora.json');
  console.log('Primero ejecutá el script de conversión del Excel');
  process.exit(1);
}

const codigos = JSON.parse(fs.readFileSync(codigosPath, 'utf8'));
const codigosArray = Object.entries(codigos).map(([codigo, sku]) => ({ codigo, sku }));

console.log('Códigos a importar:', codigosArray.length);

// Hacer request al endpoint de importación
const API_URL = process.env.API_URL || 'http://localhost:3000';

async function importar() {
  try {
    // Primero hacer login para obtener token
    console.log('Conectando a ' + API_URL + '...');

    const loginRes = await fetch(API_URL + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: process.env.AUTH_USER || 'admin',
        password: process.env.AUTH_PASSWORD || 'admin123'
      })
    });

    const loginData = await loginRes.json();
    if (!loginData.success) {
      console.error('Error de login:', loginData);
      process.exit(1);
    }

    const token = loginData.sessionToken;
    console.log('Login exitoso');

    // Importar en lotes de 500
    const batchSize = 500;
    for (let i = 0; i < codigosArray.length; i += batchSize) {
      const batch = codigosArray.slice(i, i + batchSize);

      const res = await fetch(API_URL + '/api/barcodes/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-token': token
        },
        body: JSON.stringify({ codigos: batch })
      });

      const data = await res.json();
      console.log('Lote ' + (Math.floor(i / batchSize) + 1) + ': ' + (data.imported || 0) + ' códigos importados');
    }

    console.log('Importación completada');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

importar();
