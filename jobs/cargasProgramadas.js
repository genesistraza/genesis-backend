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
          `SELECT * FROM tz_cargas_programadas WHERE estado = 'programada' AND COALESCE(modo, 'completa') = 'completa' AND programada_para <= NOW()
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
    await aplicarSimulaciones();
  } catch (e) {
    console.error('[cargas] error general:', e.message);
  } finally { ocupado = false; }
}

// Simulaciones (solo asociaciones de prueba): cada fila entra a su hora.
async function aplicarSimulaciones() {
  const { aplicarFilaSimulacion } = require('../routes/trazabilidad');
  for (;;) {
    const client = await pool.connect();
    let fila;
    try {
      await client.query('BEGIN');
      fila = (await client.query(
        `SELECT f.*, c.subido_por FROM tz_cargas_filas f JOIN tz_cargas_programadas c ON c.id = f.id_carga
         WHERE f.estado = 'pendiente' AND f.aplicar_en <= NOW() AND c.estado IN ('programada', 'en_curso')
         ORDER BY f.aplicar_en, f.id LIMIT 1 FOR UPDATE OF f SKIP LOCKED`)).rows[0];
      if (fila) await client.query("UPDATE tz_cargas_filas SET estado = 'aplicando' WHERE id = $1", [fila.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
    if (!fila) break;
    let r;
    try { r = await aplicarFilaSimulacion(fila, fila.subido_por); } catch (e) { r = { aplicada: false, motivo: e.message }; }
    await pool.query('UPDATE tz_cargas_filas SET estado = $1, resultado = $2, aplicada_en = NOW() WHERE id = $3',
      [r.aplicada ? 'aplicada' : 'omitida', r.motivo ? String(r.motivo).slice(0, 300) : null, fila.id]);
    // La carga queda 'en_curso' mientras le falten filas, y 'ejecutada' cuando termina.
    const pend = (await pool.query("SELECT count(*)::int n FROM tz_cargas_filas WHERE id_carga = $1 AND estado IN ('pendiente', 'aplicando')", [fila.id_carga])).rows[0].n;
    const tot = (await pool.query("SELECT count(*) FILTER (WHERE estado = 'aplicada')::int insertadas, count(*) FILTER (WHERE estado = 'omitida')::int omitidas FROM tz_cargas_filas WHERE id_carga = $1", [fila.id_carga])).rows[0];
    await pool.query(`UPDATE tz_cargas_programadas SET estado = $1, resultado = $2, ejecutada_en = CASE WHEN $1 = 'ejecutada' THEN NOW() ELSE ejecutada_en END
                      WHERE id = $3 AND estado IN ('programada', 'en_curso')`, [pend ? 'en_curso' : 'ejecutada', JSON.stringify(tot), fila.id_carga]);
    console.log(`[simulacion] carga #${fila.id_carga} fila ${fila.id}: ${r.aplicada ? 'aplicada' : 'omitida'}`);
  }
}

function startCargasProgramadas() {
  cron.schedule('* * * * *', aplicarPendientes);
}

module.exports = startCargasProgramadas;
module.exports.aplicarPendientes = aplicarPendientes;
