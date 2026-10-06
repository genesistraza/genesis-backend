// Cargas masivas programadas: cada minuto aplica las que ya llegaron a su hora (ver la ruta
// /trazabilidad/cargas-programadas). Cada carga se toma con FOR UPDATE SKIP LOCKED para que nunca
// se aplique dos veces, aunque haya dos instancias del servidor corriendo.
const cron = require('node-cron');
const pool = require('../db/pool');

let ocupado = false;

async function aplicarPendientes() {
  if (ocupado) return; ocupado = true;
  const { aplicarCargaProgramada } = require('../routes/trazabilidad');
  try {
    for (;;) {
      const client = await pool.connect();
      let carga;
      try {
        await client.query('BEGIN');
        carga = (await client.query(
          `SELECT * FROM tz_cargas_programadas WHERE estado = 'programada' AND programada_para <= NOW()
           ORDER BY programada_para LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
        if (carga) await client.query("UPDATE tz_cargas_programadas SET estado = 'ejecutando' WHERE id = $1", [carga.id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
      if (!carga) break;
      try {
        const r = await aplicarCargaProgramada(carga);
        await pool.query("UPDATE tz_cargas_programadas SET estado = 'ejecutada', ejecutada_en = NOW(), resultado = $1 WHERE id = $2", [JSON.stringify(r), carga.id]);
        console.log(`[cargas] #${carga.id} aplicada: ${r.insertadas} filas`);
      } catch (e) {
        await pool.query("UPDATE tz_cargas_programadas SET estado = 'error', ejecutada_en = NOW(), resultado = $1 WHERE id = $2", [JSON.stringify({ error: String(e.message).slice(0, 500) }), carga.id]);
        console.error(`[cargas] #${carga.id} fallo:`, e.message);
      }
    }
  } catch (e) {
    console.error('[cargas] error general:', e.message);
  } finally { ocupado = false; }
}

function startCargasProgramadas() {
  cron.schedule('* * * * *', aplicarPendientes);
}

module.exports = startCargasProgramadas;
module.exports.aplicarPendientes = aplicarPendientes;
