// Sistema de usuarios: replica del sistema anterior (ASP.NET) para las asociaciones.
// - Menu y permisos por perfil (gt_perfiles / gt_menu / gt_submenu / gt_perfil_opciones).
// - ADM ve todo; los perfiles con todas_asociaciones (ADM_CENTROS = equipo Genesis) ven todas las
//   asociaciones del sistema, pero solo sus opciones; USUARIOS / EMPLEADOS solo su asociacion.
// - Solo opera sobre centros con modulo = 'sistema': los del modulo Pruebas (con sello diario /
//   cadena de integridad) quedan aparte.
// Reutiliza el registro de entidades y la validacion central (utils/trazaValidate.js) de Pruebas.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { validateRecord } = require('../utils/trazaValidate');
const { ENTITIES, getEntity, guard } = require('./trazabilidad');

const router = express.Router();
router.use(requireAuth);

const PERFIL_ADM = 'ADM';

// Pantalla del menu (clave de gt_submenu) -> entidad del motor de datos.
const CLAVE_ENTIDAD = {
  centros: 'centros', numacros: 'numacros', localidades: 'localidades', tipos_material: 'tipos_material',
  recicladores: 'recicladores', balance_masas: 'balance_masas', microrrutas: 'microrrutas',
  aprovechamiento: 'aprovechamiento', pago_tarifa: 'pago_tarifa', pago_seguridad: 'pago_seguridad',
  recursos: 'recursos', usuarios: 'usuarios'
};

// Carga perfil, permisos y asociacion del usuario en cada peticion (asi un bloqueo o un cambio de
// perfil aplica de inmediato, sin esperar a que venza el token).
router.use(guard(async (req, res, next) => {
  const u = (await pool.query(
    `SELECT u.id, u.full_name, u.association_id, u.activo, u.msg_login_desactivado,
            p.id AS id_perfil, p.cod_perfil, p.desc_perfil, p.todas_asociaciones
     FROM users u LEFT JOIN gt_perfiles p ON p.id = u.id_perfil WHERE u.id = $1`, [req.user.id])).rows[0];
  if (!u) return res.status(401).json({ error: 'Sesión inválida.' });
  if (u.activo === false) return res.status(403).json({ error: u.msg_login_desactivado || 'Tu usuario está desactivado.', bloqueado: true });
  if (!u.id_perfil) return res.status(403).json({ error: 'Tu usuario no tiene un perfil asignado.' });

  const esAdm = String(u.cod_perfil).toUpperCase() === PERFIL_ADM;
  const todas = esAdm || u.todas_asociaciones;
  const centros = (await pool.query(
    todas
      ? `SELECT id, cod_centro, desc_centro, association_id FROM tz_centros WHERE modulo = 'sistema' ORDER BY desc_centro`
      : `SELECT id, cod_centro, desc_centro, association_id FROM tz_centros WHERE modulo = 'sistema' AND association_id = $1`,
    todas ? [] : [u.association_id])).rows;
  if (!todas && !centros.length) return res.status(403).json({ error: 'Tu asociación todavía no está habilitada en el sistema.' });

  // Pago mensual obligatorio para los usuarios de asociacion.
  if (!todas) {
    const s = await pool.query("SELECT 1 FROM subscriptions WHERE association_id = $1 AND status = 'activa' LIMIT 1", [u.association_id]);
    if (!s.rows.length) return res.status(402).json({ error: 'La suscripción de tu asociación no está activa.', requiereSuscripcion: true });
  }

  const claves = esAdm
    ? (await pool.query('SELECT clave FROM gt_submenu')).rows.map((r) => r.clave)
    : (await pool.query('SELECT s.clave FROM gt_perfil_opciones o JOIN gt_submenu s ON s.id = o.id_submenu WHERE o.id_perfil = $1', [u.id_perfil])).rows.map((r) => r.clave);

  req.sis = { usuario: u, esAdm, todas, centros, idsCentros: centros.map((c) => c.id), claves: new Set(claves) };
  next();
}));

function etiquetaSesion(s) {
  if (s.esAdm) return 'Usuario: Administrador';
  if (s.todas) return 'Usuario: Administrador asociaciones';
  return 'Asociación: ' + (s.centros[0] ? s.centros[0].desc_centro : '');
}

// GET /sistema/me -> perfil, asociacion(es) visibles y etiqueta de la barra de titulo
router.get('/me', (req, res) => {
  const s = req.sis;
  res.json({
    nombre: s.usuario.full_name, perfil: s.usuario.cod_perfil, descPerfil: s.usuario.desc_perfil,
    todasAsociaciones: s.todas, centros: s.centros.map((c) => ({ id: c.id, cod: c.cod_centro, nombre: c.desc_centro })),
    etiqueta: etiquetaSesion(s)
  });
});

// GET /sistema/menu -> menu horizontal con sus submenus permitidos (misma regla del sistema viejo:
// un item se muestra si no tiene submenus, si el perfil es ADM o si tiene al menos un submenu permitido).
router.get('/menu', guard(async (req, res) => {
  const items = (await pool.query('SELECT id, cod_item, descripcion, clave FROM gt_menu ORDER BY cod_item, id')).rows;
  const subs = (await pool.query('SELECT id, id_menu, cod_item, descripcion, clave FROM gt_submenu ORDER BY cod_item, id')).rows;
  const out = [];
  for (const it of items) {
    const todos = subs.filter((x) => x.id_menu === it.id);
    const visibles = todos.filter((x) => req.sis.claves.has(x.clave));
    if (todos.length && !visibles.length) continue;
    out.push({ descripcion: it.descripcion, clave: it.clave, submenu: visibles.map((x) => ({ descripcion: x.descripcion, clave: x.clave })) });
  }
  res.json(out);
}));

// ---- Datos (CRUD) por pantalla, acotados a las asociaciones visibles ----

// Condicion ($1 = arreglo de ids de centro) que acota una entidad a esos centros, o null si es global.
function condCentros(key, entity) {
  if (key === 'centros') return 't.id = ANY($1::int[])';
  if (entity.fields.some((f) => f.name === 'id_centro')) return 't.id_centro = ANY($1::int[])';
  return null;
}

// Resuelve la pantalla pedida: exige permiso y devuelve la entidad. null si ya respondio el error.
function pantalla(req, res) {
  const clave = req.params.clave;
  const key = Object.prototype.hasOwnProperty.call(CLAVE_ENTIDAD, clave) ? CLAVE_ENTIDAD[clave] : null;
  if (!key) { res.status(404).json({ error: 'Pantalla no encontrada.' }); return null; }
  if (!req.sis.claves.has(clave)) { res.status(403).json({ error: 'Tu perfil no tiene acceso a esta opción.' }); return null; }
  return { key, entity: getEntity(key) };
}

// Las tablas globales (sin centro: tipos de material, localidades) y la ficha de la asociacion solo
// las modifican los perfiles que ven todas las asociaciones.
function puedeEscribir(req, key, entity) {
  if (req.sis.todas) return true;
  return key !== 'centros' && !!condCentros(key, entity);
}

// Centro de la fila: el usuario de asociacion siempre escribe en la suya; los demas eligen entre las visibles.
function centroDestino(req, valor) {
  if (!req.sis.todas) return req.sis.idsCentros[0];
  const n = Number(valor);
  return req.sis.idsCentros.includes(n) ? n : null;
}

// GET /sistema/entidades -> metadata de campos de las pantallas permitidas (para armar tablas y formularios)
router.get('/entidades', (req, res) => {
  const out = {};
  for (const clave in CLAVE_ENTIDAD) {
    if (!req.sis.claves.has(clave)) continue;
    const key = CLAVE_ENTIDAD[clave], e = ENTITIES[key];
    // El usuario de asociacion no elige centro: se asigna el suyo.
    const fields = req.sis.todas ? e.fields : e.fields.filter((f) => f.name !== 'id_centro');
    out[clave] = { label: e.label, fields, soloLectura: !puedeEscribir(req, key, e) };
  }
  res.json(out);
});

// GET /sistema/opciones/:entidad?labelField=x -> opciones de un select-entity, solo de las asociaciones visibles
router.get('/opciones/:entidad', guard(async (req, res) => {
  const entity = getEntity(req.params.entidad);
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });
  const labelField = req.query.labelField;
  if (!(labelField === 'id' || entity.fields.some((f) => f.name === labelField))) return res.status(400).json({ error: 'Campo de etiqueta inválido.' });
  const cond = condCentros(req.params.entidad, entity);
  if (!cond && ['seguridad_social', 'microrrutas_detalle'].includes(req.params.entidad)) return res.json([]);
  const r = await pool.query(
    `SELECT t.id AS value, ${labelField === 'id' ? 't.id::text' : 't.' + labelField} AS label FROM ${entity.table} t ${cond ? 'WHERE ' + cond : ''} ORDER BY 2`,
    cond ? [req.sis.idsCentros] : []);
  res.json(r.rows);
}));

// GET /sistema/catalogo/:categoria -> opciones de un select-catalogo
router.get('/catalogo/:categoria', guard(async (req, res) => {
  const r = await pool.query('SELECT id AS value, descripcion AS label FROM tz_catalogos WHERE categoria = $1 ORDER BY orden, descripcion', [req.params.categoria]);
  res.json(r.rows);
}));

// GET /sistema/datos/:clave[?id_centro=X] -> filas visibles, con etiquetas de sus listas resueltas
router.get('/datos/:clave', guard(async (req, res) => {
  const p = pantalla(req, res); if (!p) return;
  const { key, entity } = p;
  const cols = ['t.id'], joins = [];
  entity.fields.forEach((f, i) => {
    cols.push(`t.${f.name}`);
    const a = 'j' + i;
    if (f.type === 'select-entity') {
      const ref = getEntity(f.entity);
      cols.push(`${f.labelField === 'id' ? a + '.id::text' : a + '.' + f.labelField} AS ${f.name}_label`);
      joins.push(`LEFT JOIN ${ref.table} ${a} ON ${a}.id = t.${f.name}`);
    } else if (f.type === 'select-catalogo') {
      cols.push(`${a}.descripcion AS ${f.name}_label`);
      joins.push(`LEFT JOIN tz_catalogos ${a} ON ${a}.id = t.${f.name}`);
    }
  });
  const cond = condCentros(key, entity);
  let ids = req.sis.idsCentros;
  if (cond && req.query.id_centro) {
    const n = Number(req.query.id_centro);
    if (!ids.includes(n)) return res.status(403).json({ error: 'No tienes acceso a esa asociación.' });
    ids = [n];
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 5000);
  const r = await pool.query(
    `SELECT ${cols.join(', ')} FROM ${entity.table} t ${joins.join(' ')} ${cond ? 'WHERE ' + cond : ''} ORDER BY t.id DESC LIMIT ${limit}`,
    cond ? [ids] : []);
  res.json(r.rows);
}));

// Fila existente visible para el usuario, o null.
async function filaVisible(req, key, entity, id) {
  const cond = condCentros(key, entity);
  const r = cond
    ? await pool.query(`SELECT t.* FROM ${entity.table} t WHERE t.id = $2 AND ${cond}`, [req.sis.idsCentros, id])
    : await pool.query(`SELECT t.* FROM ${entity.table} t WHERE t.id = $1`, [id]);
  return r.rows[0] || null;
}

function sendErrores(res, errors) {
  res.status(400).json({ error: errors.slice(0, 3).join(' '), detalles: errors });
}

const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };

// POST /sistema/datos/:clave -> crear
router.post('/datos/:clave', guard(async (req, res) => {
  const p = pantalla(req, res); if (!p) return;
  const { key, entity } = p;
  if (!puedeEscribir(req, key, entity)) return res.status(403).json({ error: 'Esta tabla es de solo lectura para tu perfil.' });
  const body = { ...(req.body || {}) };
  const tieneCentro = entity.fields.some((f) => f.name === 'id_centro');
  if (tieneCentro) {
    const c = centroDestino(req, body.id_centro);
    if (!c) return res.status(400).json({ error: 'Elige una asociación válida.' });
    body.id_centro = c;
  }
  const v = await validateRecord(ENTITIES, key, body);
  if (v.errors.length) return sendErrores(res, v.errors);
  let datos = v.values;
  if (key === 'balance_masas') datos = { ...datos, creado_por: req.user.id, origen: 'manual' };
  if (key === 'centros') datos = { ...datos, modulo: 'sistema' };
  const cols = Object.keys(datos);
  const r = await pool.query(
    `INSERT INTO ${entity.table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
    cols.map((c) => datos[c]));
  await logActivity(req.user.id, 'sistema_creado', { pantalla: req.params.clave, id: r.rows[0].id }, req.ip);
  res.json({ id: r.rows[0].id });
}));

// PUT /sistema/datos/:clave/:id -> editar (solo filas de las asociaciones visibles)
router.put('/datos/:clave/:id', guard(async (req, res) => {
  const p = pantalla(req, res); if (!p) return;
  const { key, entity } = p;
  if (!puedeEscribir(req, key, entity)) return res.status(403).json({ error: 'Esta tabla es de solo lectura para tu perfil.' });
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id inválido.' });
  const actual = await filaVisible(req, key, entity, id);
  if (!actual) return res.status(404).json({ error: 'Registro no encontrado.' });
  const body = { ...(req.body || {}) };
  if (entity.fields.some((f) => f.name === 'id_centro')) {
    if (body.id_centro === undefined) delete body.id_centro;
    else {
      const c = centroDestino(req, body.id_centro);
      if (!c) return res.status(400).json({ error: 'Elige una asociación válida.' });
      body.id_centro = c;
    }
  }
  const v = await validateRecord(ENTITIES, key, body, { existing: actual, id });
  if (v.errors.length) return sendErrores(res, v.errors);
  const cols = Object.keys(v.values);
  if (!cols.length) return res.status(400).json({ error: 'Nada para actualizar.' });
  const vals = cols.map((c) => v.values[c]); vals.push(id);
  const marca = key === 'balance_masas' ? `, modificado_en = NOW(), modificado_por = ${Number(req.user.id)}` : '';
  await pool.query(`UPDATE ${entity.table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}${marca} WHERE id = $${vals.length}`, vals);
  await logActivity(req.user.id, 'sistema_editado', { pantalla: req.params.clave, id }, req.ip);
  res.json({ id });
}));

// DELETE /sistema/datos/:clave/:id
router.delete('/datos/:clave/:id', guard(async (req, res) => {
  const p = pantalla(req, res); if (!p) return;
  const { key, entity } = p;
  if (key === 'centros') return res.status(403).json({ error: 'Las asociaciones no se eliminan desde aquí.' });
  if (!puedeEscribir(req, key, entity)) return res.status(403).json({ error: 'Esta tabla es de solo lectura para tu perfil.' });
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id inválido.' });
  if (!(await filaVisible(req, key, entity, id))) return res.status(404).json({ error: 'Registro no encontrado.' });
  try {
    await pool.query(`DELETE FROM ${entity.table} WHERE id = $1`, [id]);
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'No se puede eliminar: otros registros dependen de este. Elimina primero esos registros.' });
    throw err;
  }
  await logActivity(req.user.id, 'sistema_eliminado', { pantalla: req.params.clave, id }, req.ip);
  res.json({ message: 'Eliminado.' });
}));

module.exports = router;
