// Conexión a PostgreSQL para backup de verificaciones
// Inicialización lazy: no falla si DATABASE_URL no está configurada

var { Pool } = require('pg');

var pool = null;

function getPool() {
  if (pool) return pool;

  if (!process.env.DATABASE_URL) return null;

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3
  });

  pool.on('error', function(err) {
    console.error('Error inesperado en pool PostgreSQL:', err.message);
  });

  console.log('PostgreSQL pool creado para backup de verificaciones');
  return pool;
}

function isConfigured() {
  return !!process.env.DATABASE_URL;
}

async function query(text, params) {
  var p = getPool();
  if (!p) throw new Error('DATABASE_URL no configurada');
  return p.query(text, params);
}

async function getClient() {
  var p = getPool();
  if (!p) throw new Error('DATABASE_URL no configurada');
  return p.connect();
}

module.exports = {
  isConfigured: isConfigured,
  query: query,
  getClient: getClient
};
