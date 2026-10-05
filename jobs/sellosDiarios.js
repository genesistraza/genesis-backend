// Sello diario de la cadena de integridad: a medianoche (hora Colombia) combina las huellas del dia
// anterior en un arbol Merkle, guarda la prueba de cada registro y ancla la raiz en Bitcoin con
// OpenTimestamps. Cada hora reintenta lo que haya fallado y actualiza las pruebas que Bitcoin ya
// confirmo. Estados: calculado -> pendiente (en los calendarios) -> confirmado (en un bloque).
const cron = require('node-cron');
const pool = require('../db/pool');
const { merkle, archivoSello, sha256, fechaBogota } = require('../utils/huella');
const ots = require('../utils/ots');
const { sellarDias } = require('../utils/selloDia');

let ocupado = false;

async function calcularDias() {
  const hoy = fechaBogota();
  const dias = await pool.query(
    `SELECT DISTINCT h.fecha_sello AS fecha FROM tz_huellas h
     LEFT JOIN tz_sellos_diarios s ON s.fecha = h.fecha_sello
     WHERE s.fecha IS NULL AND h.fecha_sello < $1 ORDER BY 1`, [hoy]);
  for (const { fecha } of dias.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const hs = (await client.query('SELECT id, huella FROM tz_huellas WHERE fecha_sello = $1 ORDER BY id', [fecha])).rows;
      const { raiz, pruebas } = merkle(hs.map((h) => h.huella));
      await client.query('INSERT INTO tz_sellos_diarios (fecha, raiz, total, archivo) VALUES ($1,$2,$3,$4)', [fecha, raiz, hs.length, archivoSello(fecha, raiz, hs.length)]);
      for (let i = 0; i < hs.length; i++) await client.query('UPDATE tz_huellas SET prueba = $1 WHERE id = $2', [JSON.stringify(pruebas[i]), hs[i].id]);
      await client.query('COMMIT');
      console.log(`[sellos] ${fecha}: raiz calculada con ${hs.length} registros`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[sellos] ${fecha}: no se pudo calcular la raiz:`, e.message);
    } finally { client.release(); }
  }
}

async function anclarPendientes() {
  const r = await pool.query("SELECT fecha, archivo FROM tz_sellos_diarios WHERE ots IS NULL ORDER BY fecha");
  for (const s of r.rows) {
    try {
      const buf = await ots.sellarDigest(Buffer.from(sha256(s.archivo), 'hex'));
      await pool.query("UPDATE tz_sellos_diarios SET ots = $1, estado = 'pendiente', error = NULL, actualizado = NOW() WHERE fecha = $2", [buf, s.fecha]);
      console.log(`[sellos] ${s.fecha}: enviado a OpenTimestamps`);
    } catch (e) {
      await pool.query("UPDATE tz_sellos_diarios SET estado = 'error', error = $1, actualizado = NOW() WHERE fecha = $2", [String(e.message).slice(0, 500), s.fecha]);
      console.error(`[sellos] ${s.fecha}: fallo el anclaje:`, e.message);
    }
  }
}

async function confirmarPendientes() {
  const r = await pool.query("SELECT fecha, ots FROM tz_sellos_diarios WHERE estado = 'pendiente' AND ots IS NOT NULL ORDER BY fecha");
  for (const s of r.rows) {
    try {
      const up = await ots.actualizar(s.ots);
      if (up.cambio || up.confirmado) {
        await pool.query('UPDATE tz_sellos_diarios SET ots = $1, estado = $2, bloque = $3, actualizado = NOW() WHERE fecha = $4',
          [up.ots, up.confirmado ? 'confirmado' : 'pendiente', up.bloque, s.fecha]);
        if (up.confirmado) console.log(`[sellos] ${s.fecha}: confirmado en el bloque ${up.bloque} de Bitcoin`);
      }
    } catch (e) { console.error(`[sellos] ${s.fecha}: no se pudo actualizar:`, e.message); }
  }
}

async function ciclo() {
  if (ocupado) return; ocupado = true;
  try { await calcularDias(); await anclarPendientes(); await confirmarPendientes(); }
  catch (e) { console.error('[sellos] error general:', e.message); }
  finally { ocupado = false; }
}

// 23:59: sello del dia de cada asociacion (y nuevas versiones de dias que cambiaron).
async function selloAsociaciones() {
  try { const r = await sellarDias(); console.log(`[sello-dia] dias nuevos ${r.nuevos}, versiones nuevas ${r.versiones}`); }
  catch (e) { console.error('[sello-dia] error general:', e.message); }
}

function startSellosDiarios() {
  cron.schedule('59 23 * * *', selloAsociaciones, { timezone: 'America/Bogota' });
  cron.schedule('10 0 * * *', ciclo, { timezone: 'America/Bogota' }); // sello del dia anterior
  cron.schedule('25 * * * *', ciclo, { timezone: 'America/Bogota' }); // reintentos y confirmaciones
  setTimeout(ciclo, 60 * 1000); // al arrancar, pone al dia lo que haya quedado pendiente
}

module.exports = startSellosDiarios;
module.exports.ciclo = ciclo;
module.exports.selloAsociaciones = selloAsociaciones;
