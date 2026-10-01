// Sella en bloque los comprobantes que existian antes de la cadena de integridad. Su sello lleva la
// fecha de hoy: la garantia de esos registros empieza el dia en que se sellan, no antes.
// Uso: node db/sellar_historicos.js   (se puede correr varias veces: solo sella lo que falte)
require('dotenv').config();
const pool = require('./pool');
const { sellar } = require('../utils/huella');

(async () => {
  const r = await pool.query(
    `SELECT c.id, c.numero, c.fecha, c.id_centro, c.id_reciclador, c.snapshot FROM tz_comprobantes c
     LEFT JOIN tz_huellas h ON h.tipo = 'comprobante' AND h.ref_id = c.id
     WHERE h.id IS NULL ORDER BY c.created_at, c.id`);
  let n = 0;
  for (const c of r.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await sellar(client, { tipo: 'comprobante', version: 'comprobante-v1', refId: c.id, idCentro: c.id_centro, registro: c });
      await client.query('COMMIT'); n++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('No se pudo sellar el comprobante', c.numero, e.message);
    } finally { client.release(); }
  }
  console.log(`Comprobantes sellados: ${n} de ${r.rows.length} pendientes.`);
  await pool.end();
})();
