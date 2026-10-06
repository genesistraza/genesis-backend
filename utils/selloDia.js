// Sello diario por asociacion: cada noche (23:59 hora Colombia) se congela una copia de todos los
// datos transaccionales del dia de cada centro (recepcion por reciclador y material, rechazo y no
// SUI), se calcula su huella y se encadena (utils/huella.js). Si despues alguien cambia un dia ya
// sellado, la siguiente pasada detecta la diferencia y sella una VERSION nueva de ese dia con el
// detalle de que cambio y el motivo registrado; la version anterior nunca se borra.
const pool = require('../db/pool');
const huella = require('./huella');

// ID codificado del reciclador: se muestra en la consulta publica en vez del nombre y la cedula.
const codReciclador = (id) => 'REC-' + String(id).padStart(4, '0');
const pad = (n) => String(n).padStart(2, '0');

// Copia canonica del dia de un centro. Los NUMERIC llegan como texto ('120.0000'), asi que la
// huella no depende de redondeos de punto flotante.
async function datosDelDia(q, idCentro, fecha) {
  const r = await q.query(
    `SELECT bm.id_reciclador, tm.cod_tipo_material AS mat_cod, tm.desc_tipo_material AS mat,
            bm.cantidad::text AS cantidad, bm.valor::text AS valor, bm.cantidad_rechazo::text AS rechazo,
            bm.cantidad_nosui::text AS nosui, b.cod_bodega AS eca, m.cod_macrorruta AS macrorruta,
            to_char(bm.creado_en AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS registrado,
            to_char(bm.modificado_en AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS modificado,
            bm.origen = 'simulacion' AS simulacion
     FROM tz_formulario_balance_masas bm
     LEFT JOIN tz_tipos_material tm ON tm.id = bm.id_tipo_material
     LEFT JOIN tz_bodegas b ON b.id = bm.id_bodega
     LEFT JOIN tz_macrorrutas m ON m.id = bm.id_macrorruta
     WHERE bm.id_centro = $1 AND bm.fecha = $2 ORDER BY bm.id`, [idCentro, fecha]);
  const filas = r.rows.map((x) => ({
    reciclador: codReciclador(x.id_reciclador), material_codigo: x.mat_cod == null ? null : String(x.mat_cod), material: x.mat,
    cantidad: x.cantidad, valor: x.valor, rechazo: x.rechazo, nosui: x.nosui, eca: x.eca, macrorruta: x.macrorruta,
    // Hora (Colombia) en que el dato entro al sistema y su ultima modificacion. El origen (manual,
    // Excel o carga programada) queda solo en la base de datos, no en el sello publico.
    registrado: x.registrado, modificado: x.modificado,
    // Las filas de simulacion (solo asociaciones de prueba) quedan marcadas en el sello.
    ...(x.simulacion ? { simulacion: true } : {}),
  })).sort((a, b) => (a.reciclador + '|' + a.material).localeCompare(b.reciclador + '|' + b.material) || huella.canonico(a).localeCompare(huella.canonico(b)));
  return { filas };
}

const claveFila = (f) => f.reciclador + '|' + (f.material_codigo || f.material);
// Proyeccion de negocio de una fila y llaves unicas aun con filas repetidas (mismo reciclador y
// material dos veces el mismo dia): se ordenan por contenido y se numeran (#1, #2...).
const proyectar = (f) => Object.fromEntries(CAMPOS_BASE.map((c) => [c, f[c] === undefined ? null : f[c]]));
function conLlaves(filas) {
  const orden = filas.map((f) => ({ f, k: claveFila(f), c: huella.canonico(proyectar(f)) })).sort((a, b) => a.k.localeCompare(b.k) || a.c.localeCompare(b.c));
  const vistos = {};
  return orden.map((x) => { vistos[x.k] = (vistos[x.k] || 0) + 1; return { llave: x.k + '#' + vistos[x.k], f: x.f, c: x.c }; });
}
const CAMPOS = ['cantidad', 'valor', 'rechazo', 'nosui', 'eca', 'macrorruta'];
const CAMPOS_BASE = CAMPOS;
// Contenido de negocio de las filas (sin horas ni origen): es lo que decide si el dia cambio. Asi
// los dias sellados antes de existir las horas no generan versiones nuevas solo por agregarlas.
const negocio = (filas) => huella.canonico(conLlaves(filas).map((x) => x.llave + '=' + x.c));

// Diferencias entre dos versiones del mismo dia, fila por fila.
function diferencias(antes, despues) {
  const A = new Map(conLlaves(antes).map((x) => [x.llave, x.f])), B = new Map(conLlaves(despues).map((x) => [x.llave, x.f]));
  const out = [];
  for (const [k, f] of B) {
    const a = A.get(k);
    if (!a) { out.push({ tipo: 'agregado', reciclador: f.reciclador, material: f.material, despues: f }); continue; }
    const campos = CAMPOS.filter((c) => String(a[c]) !== String(f[c])).map((c) => ({ campo: c, antes: a[c], despues: f[c] }));
    if (campos.length) out.push({ tipo: 'modificado', reciclador: f.reciclador, material: f.material, campos });
  }
  for (const [k, a] of A) if (!B.has(k)) out.push({ tipo: 'eliminado', reciclador: a.reciclador, material: a.material, antes: a });
  return out;
}

// Codigo corto para buscar el sello: GT<centro>-<AAAAMMDD>-V<version>-<6 primeros de la huella>.
const codigoSello = (idCentro, fecha, version, h) => `GT${idCentro}-${fecha.replace(/-/g, '')}-V${version}-${h.slice(0, 6).toUpperCase()}`;

// Revisa todos los dias con datos (o ya sellados) y sella lo que falte o haya cambiado.
async function sellarDias({ hasta = huella.fechaBogota() } = {}) {
  const dias = (await pool.query(
    `SELECT id_centro, fecha FROM tz_formulario_balance_masas WHERE fecha <= $1 GROUP BY 1, 2
     UNION SELECT id_centro, fecha FROM tz_sellos_asociacion WHERE fecha <= $1 GROUP BY 1, 2
     ORDER BY 2, 1`, [hasta])).rows;
  let nuevos = 0, versiones = 0;
  for (const { id_centro: idCentro, fecha } of dias) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(7102, $1)', [idCentro]);
      const ult = (await client.query('SELECT * FROM tz_sellos_asociacion WHERE id_centro = $1 AND fecha = $2 ORDER BY version DESC LIMIT 1', [idCentro, fecha])).rows[0];
      const { filas } = await datosDelDia(client, idCentro, fecha);
      const centro = (await client.query('SELECT desc_centro, es_prueba FROM tz_centros WHERE id = $1', [idCentro])).rows[0];
      const version = ult ? ult.version + 1 : 1;
      const datos = { tipo: 'dia-asociacion', v: 2, id_centro: idCentro, centro: centro ? centro.desc_centro : null, fecha, filas, ...(centro && centro.es_prueba ? { prueba: true } : {}) };
      // Solo se compara el contenido (filas): si el dia no cambio, no se sella otra version.
      if (ult && negocio(ult.datos.filas) === negocio(filas)) { await client.query('ROLLBACK'); continue; }
      if (!ult && !filas.length) { await client.query('ROLLBACK'); continue; }
      let cambios = null, motivo = null;
      if (ult) {
        cambios = diferencias(ult.datos.filas, filas);
        const m = (await client.query(
          `SELECT motivo, usuario AS email, creado FROM tz_cambios_sellados
           WHERE id_centro = $1 AND fecha = $2 AND creado > $3 ORDER BY creado`, [idCentro, fecha, ult.creado])).rows;
        // Solo el texto del motivo: quien hizo el cambio queda en tz_cambios_sellados (privado), no en
        // el sello, que se muestra en la consulta publica.
        motivo = m.length ? m.map((x) => x.motivo).join(' · ') : 'Cambio sin motivo registrado';
      }
      const ins = await client.query(
        `INSERT INTO tz_sellos_asociacion (id_centro, fecha, version, datos, cambios, motivo, codigo)
         VALUES ($1,$2,$3,$4,$5,$6,'pendiente') RETURNING id, id_centro, fecha, version, datos`,
        [idCentro, fecha, version, JSON.stringify(datos), cambios ? JSON.stringify(cambios) : null, motivo]);
      const s = ins.rows[0];
      const h = await huella.sellar(client, { tipo: 'dia', version: 'dia-v1', refId: s.id, idCentro, registro: s });
      await client.query('UPDATE tz_sellos_asociacion SET codigo = $1, huella = $2 WHERE id = $3', [codigoSello(idCentro, fecha, version, h.huella), h.huella, s.id]);
      await client.query('COMMIT');
      if (version === 1) nuevos++; else versiones++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[sello-dia] centro ${idCentro} ${fecha}:`, e.message);
    } finally { client.release(); }
  }
  return { nuevos, versiones };
}

// Un dia ya sellado solo se puede cambiar dando un motivo (queda en el historial del sello).
// Devuelve las fechas selladas de esa lista para un centro.
async function fechasSelladas(idCentro, fechas) {
  const f = [...new Set(fechas.filter(Boolean))];
  if (!idCentro || !f.length) return [];
  const r = await pool.query('SELECT DISTINCT fecha FROM tz_sellos_asociacion WHERE id_centro = $1 AND fecha = ANY($2::date[])', [idCentro, f]);
  return r.rows.map((x) => x.fecha);
}
async function registrarMotivo(idCentro, fechas, motivo, userId, accion) {
  const u = (await pool.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0];
  for (const fecha of [...new Set(fechas)]) {
    await pool.query('INSERT INTO tz_cambios_sellados (id_centro, fecha, motivo, user_id, usuario, accion) VALUES ($1,$2,$3,$4,$5,$6)', [idCentro, fecha, motivo, userId, u ? u.email : null, accion]);
  }
}
const leerMotivo = (req) => {
  const raw = req.get('X-Motivo-Cambio');
  if (!raw) return '';
  try { return decodeURIComponent(raw).trim().slice(0, 500); } catch (e) { return ''; }
};

module.exports = { codReciclador, datosDelDia, diferencias, codigoSello, sellarDias, fechasSelladas, registrarMotivo, leerMotivo };
