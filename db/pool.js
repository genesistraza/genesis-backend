const { Pool, types } = require('pg');

// Las columnas DATE se devuelven como texto 'YYYY-MM-DD' y no como objeto Date: un Date se
// arma a medianoche en la zona horaria del servidor y al serializarse a JSON (UTC) el navegador
// en Colombia (UTC-5) lo muestra un dia antes. Como texto, la fecha viaja igual de punta a punta.
types.setTypeParser(1082, (value) => value);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

module.exports = pool;
