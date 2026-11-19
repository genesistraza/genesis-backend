// Sistema de usuarios: replica del sistema anterior (ASP.NET) para las asociaciones.
// - Menu y permisos por perfil (gt_perfiles / gt_menu / gt_submenu / gt_perfil_opciones).
// - ADM ve todo; los perfiles con todas_asociaciones (ADM_CENTROS = equipo Genesis) ven todas las
//   asociaciones del sistema, pero solo sus opciones; USUARIOS / EMPLEADOS solo su asociacion.
// - Solo opera sobre centros con modulo = 'sistema': los del modulo Pruebas (con sello diario /
//   cadena de integridad) quedan aparte.
// Reutiliza el registro de entidades y la validacion central (utils/trazaValidate.js) de Pruebas.
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const comprobantes = require('./comprobantes');
const huella = require('../utils/huella'); // solo su forma canonica de comparar datos (no sella nada)
const pool = require('../db/pool');
const cloudinary = require('../db/cloudinary');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { validateRecord, isValidYmd, todayCO } = require('../utils/trazaValidate');
const { ENTITIES, getEntity, guard, HANDLERS, parsearArchivo, insertarFilas, plantillaEntidad } = require('./trazabilidad');

const router = express.Router();
router.use(requireAuth);
const uploadExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const uploadDoc = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const PERFIL_ADM = 'ADM';
const ID_ASOC_GENESIS = 1; // "Genesis Traza (Administracion)": asociacion de los usuarios del equipo Genesis

// Pantalla del menu (clave de gt_submenu) -> entidad del motor de datos.
const CLAVE_ENTIDAD = {
  centros: 'centros', numacros: 'numacros', localidades: 'localidades', tipos_material: 'tipos_material',
  recicladores: 'recicladores', balance_masas: 'balance_masas', microrrutas: 'microrrutas',
  aprovechamiento: 'aprovechamiento', pago_tarifa: 'pago_tarifa', pago_seguridad: 'pago_seguridad',
  recursos: 'recursos', usuarios: 'usuarios', nuaps: 'nuaps', bodegas: 'bodegas', macrorrutas: 'macrorrutas',
  areas_prestacion: 'areas_prestacion',
  microrrutas_detalle: 'microrrutas_detalle' // sub-pantalla de Formulario microrrutas
};
// Sub-pantallas: se permiten si el perfil tiene la pantalla principal.
const PERMISO_DE = { microrrutas_detalle: 'microrrutas' };

// Pantallas de "Tablas de referencia" que son listas de codigos (tz_catalogos, por categoria).
const CLAVE_CATALOGO = {
  estados: 'estados', ciudades: 'ciudades', tipos_microrrutas: 'tipos_microrruta',
  conceptos_pago_tarifa: 'tipos_concepto_pago_tarifa', conceptos_pago_seguridad: 'tipos_concepto_pago_seguridad',
  operadores: 'operadores', usuario_uso: 'usuario_uso', usuario_tipo: 'usuario_tipo',
  usuario_multiusuario: 'usuario_multiusuario', usuario_aforado: 'usuario_aforado', usuario_ubicacion: 'usuario_ubicacion',
  usuario_clase_uso: 'usuario_clase_de_uso', usuario_tipo_aforo: 'usuario_tipo_de_aforo',
  lista_documentos: 'tipos_documento_asociacion'
};

// Tipos de cargue masivo: entidad y pantallas que lo habilitan (formulario o su lista de cargues).
const CARGUES = {
  balance_masas: { entidad: 'balance_masas', label: 'Balance de masas', claves: ['balance_masas', 'cargues_balance_masas'], lista: 'cargues_balance_masas' },
  aprovechamiento: { entidad: 'aprovechamiento', label: 'Aforados aprovechamiento', claves: ['aprovechamiento', 'cargues_aprovechamiento'], lista: 'cargues_aprovechamiento' },
  usuarios: { entidad: 'usuarios', label: 'Usuarios', claves: ['usuarios', 'cargues_usuarios'], lista: 'cargues_usuarios' },
  ventas: { entidad: 'ventas', label: 'Ventas', claves: ['cargues_ventas'], lista: 'cargues_ventas' },
  pago_tarifa: { entidad: 'pago_tarifa', label: 'Pago tarifas', claves: ['pago_tarifa', 'cargues_pago_tarifa'], lista: 'cargues_pago_tarifa' },
  pago_seguridad: { entidad: 'pago_seguridad', label: 'Pago seguridad', claves: ['pago_seguridad', 'cargues_pago_seguridad'], lista: 'cargues_pago_seguridad' },
  recursos: { entidad: 'recursos', label: 'Recursos', claves: ['recursos'], lista: null },
  recicladores: { entidad: 'recicladores', label: 'Recicladores', claves: ['recicladores'], lista: null }
};

const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
const sendErrores = (res, errors) => res.status(400).json({ error: errors.slice(0, 3).join(' '), detalles: errors });

// Carga perfil, permisos y asociacion del usuario en cada peticion (asi un bloqueo o un cambio de
// perfil aplica de inmediato, sin esperar a que venza el token).
router.use(guard(async (req, res, next) => {
  const u = (await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role, u.association_id, u.activo, u.msg_login_desactivado,
            p.id AS id_perfil, p.cod_perfil, p.desc_perfil, p.todas_asociaciones
     FROM users u LEFT JOIN gt_perfiles p ON p.id = u.id_perfil WHERE u.id = $1`, [req.user.id])).rows[0];
  if (!u) return res.status(401).json({ error: 'Sesión inválida.' });
  if (u.activo === false) return res.status(403).json({ error: u.msg_login_desactivado || 'Tu usuario está desactivado.', bloqueado: true });
  if (!u.id_perfil) return res.status(403).json({ error: 'Tu usuario no tiene un perfil asignado.' });

  const esAdm = String(u.cod_perfil).toUpperCase() === PERFIL_ADM;
  const todas = esAdm || u.todas_asociaciones;
  const centros = (await pool.query(
    todas
      ? `SELECT id, cod_centro, desc_centro, association_id, link_dashboard FROM tz_centros WHERE modulo = 'sistema' ORDER BY desc_centro`
      : `SELECT id, cod_centro, desc_centro, association_id, link_dashboard FROM tz_centros WHERE modulo = 'sistema' AND association_id = $1`,
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

const tiene = (req, clave) => req.sis.claves.has(own(PERMISO_DE, clave) ? PERMISO_DE[clave] : clave);
function exigir(clave) {
  return (req, res, next) => (tiene(req, clave) ? next() : res.status(403).json({ error: 'Tu perfil no tiene acceso a esta opción.' }));
}
function exigirAlguna(claves) {
  return (req, res, next) => (claves.some((c) => tiene(req, c)) ? next() : res.status(403).json({ error: 'Tu perfil no tiene acceso a esta opción.' }));
}

function etiquetaSesion(s) {
  if (s.esAdm) return 'Usuario: Administrador';
  if (s.todas) return 'Usuario: Administrador asociaciones';
  return 'Asociación: ' + (s.centros[0] ? s.centros[0].desc_centro : '');
}

// GET /sistema/me -> perfil, asociacion(es) visibles y etiqueta de la barra de titulo
router.get('/me', (req, res) => {
  const s = req.sis;
  res.json({
    nombre: s.usuario.full_name, perfil: s.usuario.cod_perfil, descPerfil: s.usuario.desc_perfil, esAdm: s.esAdm,
    todasAsociaciones: s.todas, centros: s.centros.map((c) => ({ id: c.id, cod: c.cod_centro, nombre: c.desc_centro })),
    etiqueta: etiquetaSesion(s), hoy: todayCO()
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

// ============================== Datos (CRUD) por pantalla ==============================

// Condicion ($1 = arreglo de ids de centro) que acota una entidad a esos centros, o null si es global.
function condCentros(key, entity) {
  if (key === 'centros') return 't.id = ANY($1::int[])';
  if (entity.fields.some((f) => f.name === 'id_centro')) return 't.id_centro = ANY($1::int[])';
  if (key === 'microrrutas_detalle') return 't.id_formulario_microrruta IN (SELECT id FROM tz_formulario_microrrutas WHERE id_centro = ANY($1::int[]))';
  if (key === 'seguridad_social') return 't.id_reciclador IN (SELECT id FROM tz_recicladores WHERE id_centro = ANY($1::int[]))';
  return null;
}

// Resuelve la pantalla pedida: exige permiso y devuelve la entidad. null si ya respondio el error.
function pantalla(req, res) {
  const clave = req.params.clave;
  const key = own(CLAVE_ENTIDAD, clave) ? CLAVE_ENTIDAD[clave] : null;
  if (!key) { res.status(404).json({ error: 'Pantalla no encontrada.' }); return null; }
  if (!tiene(req, clave)) { res.status(403).json({ error: 'Tu perfil no tiene acceso a esta opción.' }); return null; }
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

// Campos que el usuario no debe ver/llenar: el centro (si es de una sola asociacion) y los codigos
// fijos del destino del rechazo y el enlace del dashboard (tareas del administrador).
const SOLO_ADMIN = new Set(['id_tipo_destino', 'numero_sitio_destino', 'link_dashboard']);
function camposVisibles(req, key, entity) {
  return entity.fields.filter((f) => (req.sis.todas || f.name !== 'id_centro') && (req.sis.todas || key !== 'centros' || !SOLO_ADMIN.has(f.name)));
}

// GET /sistema/entidades -> metadata de campos de las pantallas permitidas (para armar tablas y formularios)
router.get('/entidades', (req, res) => {
  const out = {};
  for (const clave in CLAVE_ENTIDAD) {
    if (!tiene(req, clave)) continue;
    const key = CLAVE_ENTIDAD[clave], e = ENTITIES[key];
    out[clave] = { label: e.label, fields: camposVisibles(req, key, e), soloLectura: !puedeEscribir(req, key, e) };
  }
  for (const clave in CLAVE_CATALOGO) {
    if (!tiene(req, clave)) continue;
    out[clave] = { catalogo: true, soloLectura: !req.sis.todas, fields: [
      { name: 'codigo', label: 'Código', type: 'text', required: true },
      { name: 'descripcion', label: 'Descripción', type: 'text', required: true },
      { name: 'orden', label: 'Orden', type: 'number' }] };
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
  const label = req.params.entidad === 'microrrutas'
    ? `t.id::text || ' - ' || COALESCE((SELECT nombre_completo FROM tz_recicladores r WHERE r.id = t.id_reciclador), '')`
    : (labelField === 'id' ? 't.id::text' : 't.' + labelField);
  const r = await pool.query(
    `SELECT t.id AS value, ${label} AS label FROM ${entity.table} t ${cond ? 'WHERE ' + cond : ''} ORDER BY 2`,
    cond ? [req.sis.idsCentros] : []);
  res.json(r.rows);
}));

// GET /sistema/catalogo-opciones/:categoria -> opciones de un select-catalogo
router.get('/catalogo-opciones/:categoria', guard(async (req, res) => {
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
  const filtros = [];
  const params = cond ? [ids] : [];
  if (cond) filtros.push(cond);
  if (key === 'microrrutas_detalle' && parseId(req.query.id_formulario_microrruta)) {
    params.push(parseId(req.query.id_formulario_microrruta));
    filtros.push('t.id_formulario_microrruta = $' + params.length);
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 5000);
  const r = await pool.query(
    `SELECT ${cols.join(', ')} FROM ${entity.table} t ${joins.join(' ')} ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''} ORDER BY t.id DESC LIMIT ${limit}`,
    params);
  const ocultos = req.sis.todas ? [] : entity.fields.filter((f) => key === 'centros' && SOLO_ADMIN.has(f.name)).map((f) => f.name);
  res.json(ocultos.length ? r.rows.map((row) => { ocultos.forEach((c) => delete row[c]); return row; }) : r.rows);
}));

// Fila existente visible para el usuario, o null.
async function filaVisible(req, key, entity, id) {
  const cond = condCentros(key, entity);
  const r = cond
    ? await pool.query(`SELECT t.* FROM ${entity.table} t WHERE t.id = $2 AND ${cond}`, [req.sis.idsCentros, id])
    : await pool.query(`SELECT t.* FROM ${entity.table} t WHERE t.id = $1`, [id]);
  return r.rows[0] || null;
}

// La microrruta padre de un detalle debe ser de una asociacion visible.
async function microrrutaVisible(req, id) {
  if (!id) return false;
  const r = await pool.query('SELECT 1 FROM tz_formulario_microrrutas WHERE id = $1 AND id_centro = ANY($2::int[])', [Number(id), req.sis.idsCentros]);
  return r.rows.length > 0;
}

// El usuario de asociacion no puede tocar los campos reservados al administrador.
function quitarReservados(req, key, body) {
  if (!req.sis.todas && key === 'centros') SOLO_ADMIN.forEach((c) => delete body[c]);
  return body;
}

// POST /sistema/datos/:clave -> crear
router.post('/datos/:clave', guard(async (req, res) => {
  const p = pantalla(req, res); if (!p) return;
  const { key, entity } = p;
  if (!puedeEscribir(req, key, entity)) return res.status(403).json({ error: 'Esta tabla es de solo lectura para tu perfil.' });
  const body = { ...(req.body || {}) };
  if (entity.fields.some((f) => f.name === 'id_centro')) {
    const c = centroDestino(req, body.id_centro);
    if (!c) return res.status(400).json({ error: 'Elige una asociación válida.' });
    body.id_centro = c;
  }
  if (key === 'microrrutas_detalle' && !(await microrrutaVisible(req, body.id_formulario_microrruta))) {
    return res.status(400).json({ error: 'La microrruta no existe o es de otra asociación.' });
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
  const body = quitarReservados(req, key, { ...(req.body || {}) });
  if (entity.fields.some((f) => f.name === 'id_centro')) {
    if (body.id_centro === undefined) delete body.id_centro;
    else {
      const c = centroDestino(req, body.id_centro);
      if (!c) return res.status(400).json({ error: 'Elige una asociación válida.' });
      body.id_centro = c;
    }
  }
  if (key === 'microrrutas_detalle' && body.id_formulario_microrruta !== undefined && !(await microrrutaVisible(req, body.id_formulario_microrruta))) {
    return res.status(400).json({ error: 'La microrruta no existe o es de otra asociación.' });
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

// ============================== Catalogos (listas de codigos) ==============================

function catalogo(req, res) {
  const clave = req.params.clave;
  if (!own(CLAVE_CATALOGO, clave)) { res.status(404).json({ error: 'Lista no encontrada.' }); return null; }
  if (!tiene(req, clave)) { res.status(403).json({ error: 'Tu perfil no tiene acceso a esta opción.' }); return null; }
  return CLAVE_CATALOGO[clave];
}
function limpiarCatalogo(body) {
  const b = body || {};
  const codigo = String(b.codigo == null ? '' : b.codigo).trim();
  const descripcion = String(b.descripcion == null ? '' : b.descripcion).trim();
  const errors = [];
  if (!codigo) errors.push('"Código" es obligatorio.');
  if (!descripcion) errors.push('"Descripción" es obligatoria.');
  if (codigo.length > 30) errors.push('"Código": máximo 30 caracteres.');
  if (descripcion.length > 255) errors.push('"Descripción": máximo 255 caracteres.');
  let orden = 0;
  if (b.orden !== undefined && b.orden !== null && b.orden !== '') {
    orden = Number(b.orden);
    if (!Number.isInteger(orden)) errors.push('"Orden" debe ser un número entero.');
  }
  return { errors, values: { codigo, descripcion, orden } };
}

router.get('/catalogos/:clave', guard(async (req, res) => {
  const cat = catalogo(req, res); if (!cat) return;
  const r = await pool.query('SELECT id, codigo, descripcion, orden FROM tz_catalogos WHERE categoria = $1 ORDER BY orden, codigo', [cat]);
  res.json(r.rows);
}));
router.post('/catalogos/:clave', guard(async (req, res) => {
  const cat = catalogo(req, res); if (!cat) return;
  if (!req.sis.todas) return res.status(403).json({ error: 'Esta tabla es de solo lectura para tu perfil.' });
  const v = limpiarCatalogo(req.body);
  if (v.errors.length) return sendErrores(res, v.errors);
  const r = await pool.query('INSERT INTO tz_catalogos (categoria, codigo, descripcion, orden) VALUES ($1,$2,$3,$4) RETURNING id', [cat, v.values.codigo, v.values.descripcion, v.values.orden]);
  await logActivity(req.user.id, 'sistema_catalogo_creado', { lista: cat, id: r.rows[0].id }, req.ip);
  res.json({ id: r.rows[0].id });
}));
router.put('/catalogos/:clave/:id', guard(async (req, res) => {
  const cat = catalogo(req, res); if (!cat) return;
  if (!req.sis.todas) return res.status(403).json({ error: 'Esta tabla es de solo lectura para tu perfil.' });
  const v = limpiarCatalogo(req.body);
  if (v.errors.length) return sendErrores(res, v.errors);
  const r = await pool.query('UPDATE tz_catalogos SET codigo = $1, descripcion = $2, orden = $3 WHERE id = $4 AND categoria = $5 RETURNING id', [v.values.codigo, v.values.descripcion, v.values.orden, parseId(req.params.id), cat]);
  if (!r.rows.length) return res.status(404).json({ error: 'Registro no encontrado.' });
  await logActivity(req.user.id, 'sistema_catalogo_editado', { lista: cat, id: r.rows[0].id }, req.ip);
  res.json({ id: r.rows[0].id });
}));
router.delete('/catalogos/:clave/:id', guard(async (req, res) => {
  const cat = catalogo(req, res); if (!cat) return;
  if (!req.sis.todas) return res.status(403).json({ error: 'Esta tabla es de solo lectura para tu perfil.' });
  try {
    const r = await pool.query('DELETE FROM tz_catalogos WHERE id = $1 AND categoria = $2 RETURNING id', [parseId(req.params.id), cat]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registro no encontrado.' });
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'No se puede eliminar: hay registros que usan este código.' });
    throw err;
  }
  await logActivity(req.user.id, 'sistema_catalogo_eliminado', { lista: cat, id: Number(req.params.id) }, req.ip);
  res.json({ message: 'Eliminado.' });
}));

// ============================== Formulario balance de masas ==============================
// Mismo formulario de Pruebas (un reciclador, un dia, una fila por material), acotado a la asociacion.

// GET /sistema/bm/contexto -> recicladores de las asociaciones visibles y materiales
router.get('/bm/contexto', exigir('balance_masas'), guard(async (req, res) => {
  const rec = await pool.query(
    `SELECT r.id, r.id_centro, c.desc_centro AS id_centro_label, r.nombre_completo, r.nro_documento, r.tipo_de_vehiculo, r.placa
     FROM tz_recicladores r JOIN tz_centros c ON c.id = r.id_centro WHERE r.id_centro = ANY($1::int[]) ORDER BY r.nombre_completo`, [req.sis.idsCentros]);
  const mat = await pool.query('SELECT id, cod_tipo_material, desc_tipo_material, desc_familia, secuencia_orden FROM tz_tipos_material ORDER BY secuencia_orden, desc_tipo_material');
  res.json({ recicladores: rec.rows, materiales: mat.rows });
}));

async function recicladorVisible(req, id) {
  const r = await pool.query('SELECT id, id_centro FROM tz_recicladores WHERE id = $1 AND id_centro = ANY($2::int[])', [parseId(id), req.sis.idsCentros]);
  return r.rows[0] || null;
}

// GET /sistema/bm/reciclador/:id -> ECA, macrorrutas y microrrutas para el encabezado del formulario
router.get('/bm/reciclador/:id', exigir('balance_masas'), guard(async (req, res) => {
  const rec = await recicladorVisible(req, req.params.id);
  if (!rec) return res.status(404).json({ error: 'Reciclador no encontrado.' });
  const [b, m, d] = await Promise.all([
    pool.query('SELECT id, cod_bodega, desc_bodega FROM tz_bodegas WHERE id_centro = $1 ORDER BY cod_bodega', [rec.id_centro]),
    pool.query('SELECT id, cod_macrorruta, desc_macrorruta FROM tz_macrorrutas WHERE id_centro = $1 ORDER BY cod_macrorruta', [rec.id_centro]),
    pool.query(`SELECT d.id, d.desc_microrruta FROM tz_formulario_microrrutas_detalle d JOIN tz_formulario_microrrutas f ON f.id = d.id_formulario_microrruta
                WHERE f.id_centro = $1 AND (f.id_reciclador = $2 OR f.id_reciclador IS NULL) ORDER BY d.id`, [rec.id_centro, rec.id])
  ]);
  res.json({ bodegas: b.rows, macrorrutas: m.rows, microrrutas: d.rows });
}));

// POST /sistema/bm/factura {id_reciclador, fecha} -> factura diaria del reciclador (mismo diseño de
// Pruebas) con QR: al escanearlo se abre la factura en /comprobantes/<token>. Sin huella ni sello: la
// cadena de integridad queda solo en Pruebas. Se arma siempre con lo que YA esta guardado en la base;
// reimprimir sin cambios devuelve la misma factura (mismo numero y QR).
router.post('/bm/factura', exigir('balance_masas'), guard(async (req, res) => {
  const fecha = String((req.body && req.body.fecha) || '');
  if (!isValidYmd(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
  const vis = await recicladorVisible(req, req.body && req.body.id_reciclador);
  if (!vis) return res.status(404).json({ error: 'Reciclador no encontrado.' });
  const rec = (await pool.query(
    `SELECT r.id, r.nombre_completo, r.nro_documento, r.tipo_de_vehiculo, r.placa, c.desc_centro, c.nit, c.direccion, c.telefono, c.correo,
            a.logo_url
     FROM tz_recicladores r JOIN tz_centros c ON c.id = r.id_centro LEFT JOIN associations a ON a.id = c.association_id WHERE r.id = $1`, [vis.id])).rows[0];
  const filas = (await pool.query(
    `SELECT bm.cantidad, bm.valor, bm.cantidad_rechazo, bm.cantidad_nosui, tm.desc_tipo_material,
            b.cod_bodega, b.desc_bodega, m.cod_macrorruta, m.desc_macrorruta, d1.desc_microrruta AS micro1, d2.desc_microrruta AS micro2
     FROM tz_formulario_balance_masas bm
     LEFT JOIN tz_tipos_material tm ON tm.id = bm.id_tipo_material
     LEFT JOIN tz_bodegas b ON b.id = bm.id_bodega LEFT JOIN tz_macrorrutas m ON m.id = bm.id_macrorruta
     LEFT JOIN tz_formulario_microrrutas_detalle d1 ON d1.id = bm.id_microrruta_1 LEFT JOIN tz_formulario_microrrutas_detalle d2 ON d2.id = bm.id_microrruta_2
     WHERE bm.id_reciclador = $1 AND bm.fecha = $2 ORDER BY tm.secuencia_orden, bm.id`, [vis.id, fecha])).rows;
  if (!filas.length) return res.status(404).json({ error: 'Este reciclador no tiene material registrado ese día. Escribe primero los kilos.' });
  const combo = (a, b) => [a, b].filter(Boolean).join(' - ') || null;
  const rows = filas.map((r) => {
    const cantidad = Number(r.cantidad), valor = Number(r.valor);
    return { material: r.desc_tipo_material || 'Material', cantidad, valor, valorTotal: cantidad * valor, rechazo: Number(r.cantidad_rechazo), nosui: Number(r.cantidad_nosui) };
  });
  const totales = rows.reduce((t, r) => ({ cantidad: t.cantidad + r.cantidad, valorTotal: t.valorTotal + r.valorTotal, rechazo: t.rechazo + r.rechazo, nosui: t.nosui + r.nosui }),
    { cantidad: 0, valorTotal: 0, rechazo: 0, nosui: 0 });
  const [y, m, d] = fecha.split('-').map(Number);
  const f0 = filas[0];
  const datos = {
    fecha,
    diaSemana: ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()],
    centro: { nombre: rec.desc_centro, nit: rec.nit, direccion: rec.direccion, telefono: rec.telefono, correo: rec.correo, logoUrl: rec.logo_url || null },
    reciclador: { nombre: rec.nombre_completo, documento: rec.nro_documento, vehiculo: rec.tipo_de_vehiculo, placa: rec.placa },
    operacion: { eca: combo(f0.cod_bodega, f0.desc_bodega), macrorruta: combo(f0.cod_macrorruta, f0.desc_macrorruta), micro1: f0.micro1, micro2: f0.micro2 },
    rows, totales
  };
  // Misma factura si los datos no cambiaron (el logo no cuenta como cambio).
  // canonico: claves ordenadas (la base devuelve el JSON con otro orden de claves).
  const firma = (s) => huella.canonico({ c: { ...s.centro, logoUrl: null }, r: s.reciclador, o: s.operacion, rows: s.rows, t: s.totales });
  const previo = (await pool.query(
    'SELECT token, numero, snapshot, codigo_verificacion FROM tz_comprobantes WHERE id_reciclador = $1 AND fecha = $2 AND sin_cadena ORDER BY id DESC LIMIT 1',
    [vis.id, fecha])).rows[0];
  let token, numero, snapshot, codigo;
  if (previo && firma(previo.snapshot) === firma(JSON.parse(JSON.stringify(datos)))) {
    ({ token, numero, snapshot } = previo); codigo = previo.codigo_verificacion;
  } else {
    token = crypto.randomBytes(32).toString('hex');
    numero = 'BM-' + fecha.replace(/-/g, '') + '-' + String(vis.id).padStart(4, '0') + '-' + token.slice(0, 6).toUpperCase();
    snapshot = { numero, formato: 'carta', ...datos };
    codigo = comprobantes.codigoVerificacion(token, snapshot);
    await pool.query(
      `INSERT INTO tz_comprobantes (token, numero, id_centro, id_reciclador, fecha, formato, snapshot, codigo_verificacion, created_by, sin_cadena)
       VALUES ($1,$2,$3,$4,$5,'carta',$6,$7,$8,TRUE)`, [token, numero, vis.id_centro, vis.id, fecha, snapshot, codigo, req.user.id]);
    await logActivity(req.user.id, 'sistema_factura_generada', { id_reciclador: vis.id, fecha, numero }, req.ip);
  }
  const url = `${comprobantes.PUBLIC_BASE}/comprobantes/${token}`;
  const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'H', margin: 1, width: 320 });
  res.json({ ...snapshot, numero, codigo, url, qrDataUrl });
}));

router.get('/bm/dia', exigir('balance_masas'), guard(async (req, res, next) => {
  if (!(await recicladorVisible(req, req.query.id_reciclador))) return res.status(404).json({ error: 'Reciclador no encontrado.' });
  return HANDLERS.bmDiaGet(req, res, next);
}));
// El centro siempre sale del reciclador (nunca del navegador).
async function prepararDia(req, res) {
  const rec = await recicladorVisible(req, req.body && req.body.id_reciclador);
  if (!rec) { res.status(404).json({ error: 'Reciclador no encontrado.' }); return false; }
  req.body.id_centro = rec.id_centro;
  return true;
}
router.post('/bm/dia', exigir('balance_masas'), guard(async (req, res, next) => {
  if (!(await prepararDia(req, res))) return;
  return HANDLERS.bmDiaPost(req, res, next);
}));
router.post('/bm/anexar', exigir('balance_masas'), guard(async (req, res, next) => {
  if (!(await prepararDia(req, res))) return;
  return HANDLERS.bmDiaAnexar(req, res, next);
}));

// ============================== Importar datos / Lista cargues ==============================

const tiposCarguePermitidos = (req) => Object.keys(CARGUES).filter((t) => CARGUES[t].claves.some((c) => tiene(req, c)));

// GET /sistema/importar/tipos -> tipos de archivo que el perfil puede cargar
router.get('/importar/tipos', exigir('importar'), (req, res) => {
  res.json(tiposCarguePermitidos(req).map((t) => ({ tipo: t, label: CARGUES[t].label })));
});

function tipoCargue(req, res) {
  const t = req.params.tipo;
  if (!own(CARGUES, t) || !tiposCarguePermitidos(req).includes(t)) { res.status(403).json({ error: 'Tu perfil no puede cargar ese tipo de archivo.' }); return null; }
  return CARGUES[t];
}

// GET /sistema/importar/plantilla/:tipo -> plantilla .xlsx con las listas de la(s) asociacion(es) visibles
router.get('/importar/plantilla/:tipo', exigir('importar'), guard(async (req, res) => {
  const c = tipoCargue(req, res); if (!c) return;
  const buffer = await plantillaEntidad(c.entidad, getEntity(c.entidad), { idsCentros: req.sis.idsCentros, sinCentro: !req.sis.todas, sinHora: true });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_' + req.params.tipo + '.xlsx"');
  res.send(buffer);
}));

// POST /sistema/importar/:tipo (archivo) -> crea filas nuevas y registra el cargue
router.post('/importar/:tipo', exigir('importar'), uploadExcel.single('file'), guard(async (req, res) => {
  const c = tipoCargue(req, res); if (!c) return;
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo.' });
  const entity = getEntity(c.entidad);
  const fijos = req.sis.todas ? {} : { id_centro: req.sis.idsCentros[0] };
  const p = await parsearArchivo(c.entidad, entity, req.file.buffer, { idsCentros: req.sis.idsCentros, fijos });
  if (p.error) return res.status(400).json({ error: p.error });
  const { parsedRows, errores, omitidas } = p;
  if (!parsedRows.length) return res.status(400).json({ error: 'Ninguna fila fue válida.' + (errores[0] ? ' ' + errores[0] : ''), detalles: errores });
  // Todo el archivo debe ser de una sola asociacion (asi el cargue se lista y se borra completo).
  const centros = [...new Set(parsedRows.map((r) => Number(r.id_centro)))];
  if (centros.length > 1) return res.status(400).json({ error: 'El archivo trae filas de varias asociaciones. Sube un archivo por asociación.' });
  const archivo = String(req.file.originalname || 'archivo').slice(0, 255);
  const client = await pool.connect();
  let idCargue;
  try {
    await client.query('BEGIN');
    idCargue = (await client.query('INSERT INTO gt_cargues (tipo, id_centro, archivo, filas, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.params.tipo, centros[0], archivo, parsedRows.length, req.user.id])).rows[0].id;
    await insertarFilas(client, c.entidad, entity, parsedRows, { userId: req.user.id, origen: 'importacion', idCargue });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await logActivity(req.user.id, 'sistema_importado', { tipo: req.params.tipo, cargue: idCargue, filas: parsedRows.length, omitidas }, req.ip);
  res.json({ message: 'Importación completa.', cargue: idCargue, importados: parsedRows.length, omitidos: omitidas, detalles: errores });
}));

function listaCargue(req, res) {
  const t = Object.keys(CARGUES).find((k) => CARGUES[k].lista === req.params.clave);
  if (!t) { res.status(404).json({ error: 'Lista no encontrada.' }); return null; }
  if (!tiene(req, req.params.clave)) { res.status(403).json({ error: 'Tu perfil no tiene acceso a esta opción.' }); return null; }
  return t;
}

// GET /sistema/cargues/:clave -> cargues de ese tipo (como "Lista cargues-..." del sistema viejo)
router.get('/cargues/:clave', guard(async (req, res) => {
  const t = listaCargue(req, res); if (!t) return;
  const tabla = getEntity(CARGUES[t].entidad).table;
  const conCantidad = t === 'balance_masas';
  const r = await pool.query(
    `SELECT g.id, to_char(g.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS fecha, g.archivo, c.desc_centro AS asociacion,
            u.full_name AS usuario,
            (SELECT count(*) FROM ${tabla} x WHERE x.id_cargue = g.id)::int AS registros
            ${conCantidad ? `, (SELECT round(COALESCE(sum(cantidad), 0), 2) FROM ${tabla} x WHERE x.id_cargue = g.id) AS cantidad` : ''}
     FROM gt_cargues g LEFT JOIN tz_centros c ON c.id = g.id_centro LEFT JOIN users u ON u.id = g.user_id
     WHERE g.tipo = $1 AND g.id_centro = ANY($2::int[]) ORDER BY g.id DESC LIMIT 1000`, [t, req.sis.idsCentros]);
  res.json(r.rows);
}));

// DELETE /sistema/cargues/:clave/:id -> borra todas las filas de ese cargue
router.delete('/cargues/:clave/:id', guard(async (req, res) => {
  const t = listaCargue(req, res); if (!t) return;
  const id = parseId(req.params.id);
  const g = (await pool.query('SELECT id FROM gt_cargues WHERE id = $1 AND tipo = $2 AND id_centro = ANY($3::int[])', [id, t, req.sis.idsCentros])).rows[0];
  if (!g) return res.status(404).json({ error: 'Cargue no encontrado.' });
  const tabla = getEntity(CARGUES[t].entidad).table;
  const client = await pool.connect();
  let borradas;
  try {
    await client.query('BEGIN');
    borradas = (await client.query(`DELETE FROM ${tabla} WHERE id_cargue = $1`, [id])).rowCount;
    await client.query('DELETE FROM gt_cargues WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') return res.status(409).json({ error: 'No se puede borrar: otros registros dependen de filas de este cargue.' });
    throw err;
  } finally {
    client.release();
  }
  await logActivity(req.user.id, 'sistema_cargue_borrado', { tipo: t, cargue: id, filas: borradas }, req.ip);
  res.json({ message: 'Cargue borrado (' + borradas + ' registros).' });
}));

// ============================== Calendario ==============================
// GET /sistema/calendario?anio=YYYY -> dias del año (como la tabla calendario del sistema viejo).
// Todo se calcula en la base como texto: nunca pasa por la zona horaria del navegador.
router.get('/calendario', exigir('calendario'), guard(async (req, res) => {
  const anio = Number(req.query.anio) || Number(todayCO().slice(0, 4));
  if (anio < 2000 || anio > 2100) return res.status(400).json({ error: 'Año inválido.' });
  const r = await pool.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS fecha, extract(year FROM d)::int AS anio, extract(month FROM d)::int AS mes,
            (ARRAY['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'])[extract(month FROM d)::int] AS mes_desc,
            extract(day FROM d)::int AS dia, extract(isodow FROM d)::int AS dia_semana,
            (ARRAY['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'])[extract(isodow FROM d)::int] AS dia_semana_desc,
            to_char(d, 'W')::int AS semana_mes, to_char(d, 'IW')::int AS semana_anio
     FROM generate_series(make_date($1, 1, 1), make_date($1, 12, 31), interval '1 day') AS g(d) ORDER BY d`, [anio]);
  res.json(r.rows);
}));

// ============================== Documentos ==============================

function subirArchivo(buffer, carpeta) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder: carpeta, resource_type: 'auto' }, (err, result) => (err ? reject(err) : resolve(result.secure_url)));
    stream.end(buffer);
  });
}
// Estado del documento segun su vigencia (mismas reglas del sistema viejo).
const ESTADO_DOC = `CASE WHEN d.id IS NULL THEN 'Sin documento'
  WHEN d.vigencia IS NULL THEN 'Sin vigencia'
  WHEN d.vigencia > (NOW() AT TIME ZONE 'America/Bogota')::date AND d.vigencia - (NOW() AT TIME ZONE 'America/Bogota')::date BETWEEN 1 AND 15 THEN 'Por vencer'
  WHEN d.vigencia > (NOW() AT TIME ZONE 'America/Bogota')::date THEN 'Vigente'
  ELSE 'Vencido' END`;
const DIAS_DOC = `CASE WHEN d.vigencia IS NOT NULL THEN d.vigencia - (NOW() AT TIME ZONE 'America/Bogota')::date END`;
const EXT_OK = /\.(pdf|png|jpe?g|docx?|xlsx?)$/i;

// GET /sistema/documentos/asociaciones -> una fila por asociacion y tipo de documento
router.get('/documentos/asociaciones', exigir('documentos_asociaciones'), guard(async (req, res) => {
  const r = await pool.query(
    `SELECT c.id AS id_centro, c.desc_centro, l.id AS id_tipo, l.codigo, l.descripcion AS tipo, d.id, d.nombre, d.archivo_url,
            d.vigencia, to_char(d.updated_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS actualizado,
            ${ESTADO_DOC} AS estado, ${DIAS_DOC} AS dias_vigencia
     FROM tz_centros c CROSS JOIN tz_catalogos l
     LEFT JOIN gt_documentos d ON d.grupo = 'asociacion' AND d.id_centro = c.id AND d.id_tipo = l.id
     WHERE c.id = ANY($1::int[]) AND l.categoria = 'tipos_documento_asociacion'
     ORDER BY c.desc_centro, l.orden, l.codigo`, [req.sis.idsCentros]);
  res.json(r.rows);
}));

// POST /sistema/documentos/asociaciones (archivo, id_centro, id_tipo, vigencia) -> sube o reemplaza
router.post('/documentos/asociaciones', exigir('documentos_asociaciones'), uploadDoc.single('file'), guard(async (req, res) => {
  const idCentro = centroDestino(req, req.body.id_centro);
  if (!idCentro) return res.status(400).json({ error: 'Elige una asociación válida.' });
  const tipo = (await pool.query("SELECT id FROM tz_catalogos WHERE id = $1 AND categoria = 'tipos_documento_asociacion'", [parseId(req.body.id_tipo)])).rows[0];
  if (!tipo) return res.status(400).json({ error: 'Tipo de documento inválido.' });
  const vigencia = req.body.vigencia ? String(req.body.vigencia) : null;
  if (vigencia && !isValidYmd(vigencia)) return res.status(400).json({ error: 'La vigencia no es una fecha válida.' });
  const actual = (await pool.query("SELECT id FROM gt_documentos WHERE grupo = 'asociacion' AND id_centro = $1 AND id_tipo = $2", [idCentro, tipo.id])).rows[0];
  if (!req.file && !actual) return res.status(400).json({ error: 'Falta el archivo.' });
  if (req.file && !EXT_OK.test(req.file.originalname || '')) return res.status(400).json({ error: 'Formato no permitido. Usa PDF, imagen, Word o Excel.' });
  if (req.file) {
    const url = await subirArchivo(req.file.buffer, 'genesis/documentos_asociaciones');
    const nombre = String(req.file.originalname).slice(0, 255);
    if (actual) await pool.query('UPDATE gt_documentos SET nombre = $1, archivo_url = $2, vigencia = $3, user_id = $4, updated_at = NOW() WHERE id = $5', [nombre, url, vigencia, req.user.id, actual.id]);
    else await pool.query("INSERT INTO gt_documentos (grupo, id_centro, id_tipo, nombre, archivo_url, vigencia, user_id) VALUES ('asociacion',$1,$2,$3,$4,$5,$6)", [idCentro, tipo.id, nombre, url, vigencia, req.user.id]);
  } else {
    await pool.query('UPDATE gt_documentos SET vigencia = $1, user_id = $2, updated_at = NOW() WHERE id = $3', [vigencia, req.user.id, actual.id]);
  }
  await logActivity(req.user.id, 'sistema_documento_guardado', { id_centro: idCentro, id_tipo: tipo.id }, req.ip);
  res.json({ message: 'Documento guardado.' });
}));

router.delete('/documentos/asociaciones/:id', exigir('documentos_asociaciones'), guard(async (req, res) => {
  const r = await pool.query("DELETE FROM gt_documentos WHERE id = $1 AND grupo = 'asociacion' AND id_centro = ANY($2::int[]) RETURNING id", [parseId(req.params.id), req.sis.idsCentros]);
  if (!r.rows.length) return res.status(404).json({ error: 'Documento no encontrado.' });
  await logActivity(req.user.id, 'sistema_documento_eliminado', { id: r.rows[0].id }, req.ip);
  res.json({ message: 'Eliminado.' });
}));

// Documentos de referencia: generales (normas, formatos). Los suben los perfiles de todas las asociaciones.
router.get('/documentos/referencia', exigir('documentos_referencia'), guard(async (req, res) => {
  const r = await pool.query(
    `SELECT d.id, d.nombre, d.archivo_url, d.vigencia, to_char(d.updated_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS actualizado,
            ${ESTADO_DOC} AS estado, ${DIAS_DOC} AS dias_vigencia
     FROM gt_documentos d WHERE d.grupo = 'referencia' ORDER BY d.nombre`);
  res.json(r.rows);
}));
router.post('/documentos/referencia', exigir('documentos_referencia'), uploadDoc.single('file'), guard(async (req, res) => {
  if (!req.sis.todas) return res.status(403).json({ error: 'Solo el equipo Genesis sube documentos de referencia.' });
  const nombre = String(req.body.nombre || '').trim().slice(0, 255);
  if (!nombre) return res.status(400).json({ error: 'Escribe el nombre del documento.' });
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo.' });
  if (!EXT_OK.test(req.file.originalname || '')) return res.status(400).json({ error: 'Formato no permitido. Usa PDF, imagen, Word o Excel.' });
  const vigencia = req.body.vigencia ? String(req.body.vigencia) : null;
  if (vigencia && !isValidYmd(vigencia)) return res.status(400).json({ error: 'La vigencia no es una fecha válida.' });
  const url = await subirArchivo(req.file.buffer, 'genesis/documentos_referencia');
  await pool.query("INSERT INTO gt_documentos (grupo, nombre, archivo_url, vigencia, user_id) VALUES ('referencia',$1,$2,$3,$4)", [nombre, url, vigencia, req.user.id]);
  await logActivity(req.user.id, 'sistema_documento_referencia', { nombre }, req.ip);
  res.json({ message: 'Documento guardado.' });
}));
router.delete('/documentos/referencia/:id', exigir('documentos_referencia'), guard(async (req, res) => {
  if (!req.sis.todas) return res.status(403).json({ error: 'Solo el equipo Genesis elimina documentos de referencia.' });
  const r = await pool.query("DELETE FROM gt_documentos WHERE id = $1 AND grupo = 'referencia' RETURNING id", [parseId(req.params.id)]);
  if (!r.rows.length) return res.status(404).json({ error: 'Documento no encontrado.' });
  res.json({ message: 'Eliminado.' });
}));

// ============================== Resumenes ==============================

// GET /sistema/resumen-masas?desde&hasta[&id_centro] -> totales por asociacion, mes y material
router.get('/resumen-masas', exigir('resumen_masas'), guard(async (req, res) => {
  const { desde, hasta } = req.query;
  if (!isValidYmd(desde) || !isValidYmd(hasta) || desde > hasta) return res.status(400).json({ error: 'Rango de fechas inválido.' });
  let ids = req.sis.idsCentros;
  if (req.query.id_centro) {
    const n = Number(req.query.id_centro);
    if (!ids.includes(n)) return res.status(403).json({ error: 'No tienes acceso a esa asociación.' });
    ids = [n];
  }
  const r = await pool.query(
    `SELECT c.desc_centro AS asociacion, to_char(bm.fecha, 'YYYY-MM') AS mes, tm.desc_familia AS familia, tm.desc_tipo_material AS material,
            round(sum(bm.cantidad), 2) AS kg, round(sum(bm.cantidad * bm.valor), 2) AS valor_total,
            round(sum(bm.cantidad_rechazo), 2) AS rechazo, round(sum(bm.cantidad_nosui), 2) AS nosui,
            count(DISTINCT bm.id_reciclador)::int AS recicladores
     FROM tz_formulario_balance_masas bm JOIN tz_centros c ON c.id = bm.id_centro
     LEFT JOIN tz_tipos_material tm ON tm.id = bm.id_tipo_material
     WHERE bm.id_centro = ANY($1::int[]) AND bm.fecha BETWEEN $2 AND $3
     GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 5 DESC`, [ids, desde, hasta]);
  res.json(r.rows);
}));

// GET /sistema/dashboard -> enlace del dashboard y cifras del mes de cada asociacion visible
router.get('/dashboard', exigir('dashboard'), guard(async (req, res) => {
  const hoy = todayCO();
  const r = await pool.query(
    `SELECT c.id, c.desc_centro, c.link_dashboard,
            (SELECT count(*) FROM tz_recicladores r WHERE r.id_centro = c.id)::int AS recicladores,
            (SELECT round(COALESCE(sum(cantidad), 0), 2) FROM tz_formulario_balance_masas b WHERE b.id_centro = c.id AND to_char(b.fecha, 'YYYY-MM') = $2) AS kg_mes,
            (SELECT round(COALESCE(sum(cantidad * valor), 0), 2) FROM tz_formulario_balance_masas b WHERE b.id_centro = c.id AND to_char(b.fecha, 'YYYY-MM') = $2) AS valor_mes,
            (SELECT count(DISTINCT fecha)::int FROM tz_formulario_balance_masas b WHERE b.id_centro = c.id AND to_char(b.fecha, 'YYYY-MM') = $2) AS dias_mes
     FROM tz_centros c WHERE c.id = ANY($1::int[]) ORDER BY c.desc_centro`, [req.sis.idsCentros, hoy.slice(0, 7)]);
  res.json({ mes: hoy.slice(0, 7), asociaciones: r.rows });
}));

// ============================== Administracion ==============================

// ---- Perfiles acceso (solo ADM por defecto): perfiles y las opciones que ve cada uno ----
router.get('/admin/perfiles', exigir('perfiles'), guard(async (req, res) => {
  const perfiles = (await pool.query(
    `SELECT p.id, p.cod_perfil, p.desc_perfil, p.todas_asociaciones,
            (SELECT count(*) FROM users u WHERE u.id_perfil = p.id)::int AS usuarios,
            COALESCE((SELECT array_agg(o.id_submenu ORDER BY o.id_submenu) FROM gt_perfil_opciones o WHERE o.id_perfil = p.id), '{}') AS opciones
     FROM gt_perfiles p ORDER BY p.id`)).rows;
  const opciones = (await pool.query(
    'SELECT s.id, s.descripcion, s.clave, m.descripcion AS menu FROM gt_submenu s JOIN gt_menu m ON m.id = s.id_menu ORDER BY m.cod_item, s.cod_item, s.id')).rows;
  res.json({ perfiles, opciones });
}));

function limpiarPerfil(b) {
  const cod = String((b && b.cod_perfil) || '').trim().toUpperCase();
  const desc = String((b && b.desc_perfil) || '').trim();
  const errors = [];
  if (!/^[A-Z0-9_]{2,30}$/.test(cod)) errors.push('Código: 2 a 30 letras, números o _.');
  if (!desc || desc.length > 120) errors.push('Descripción obligatoria (máximo 120).');
  return { errors, values: { cod, desc, todas: !!(b && b.todas_asociaciones) } };
}
router.post('/admin/perfiles', exigir('perfiles'), guard(async (req, res) => {
  const v = limpiarPerfil(req.body);
  if (v.errors.length) return sendErrores(res, v.errors);
  if (v.values.cod === PERFIL_ADM) return res.status(400).json({ error: 'El código ADM está reservado.' });
  const r = await pool.query('INSERT INTO gt_perfiles (cod_perfil, desc_perfil, todas_asociaciones) VALUES ($1,$2,$3) RETURNING id', [v.values.cod, v.values.desc, v.values.todas]);
  await logActivity(req.user.id, 'sistema_perfil_creado', { id: r.rows[0].id }, req.ip);
  res.json({ id: r.rows[0].id });
}));
router.put('/admin/perfiles/:id', exigir('perfiles'), guard(async (req, res) => {
  const id = parseId(req.params.id);
  const actual = (await pool.query('SELECT cod_perfil FROM gt_perfiles WHERE id = $1', [id])).rows[0];
  if (!actual) return res.status(404).json({ error: 'Perfil no encontrado.' });
  if (actual.cod_perfil === PERFIL_ADM) return res.status(400).json({ error: 'El perfil ADM no se modifica: siempre ve todo.' });
  const v = limpiarPerfil(req.body);
  if (v.errors.length) return sendErrores(res, v.errors);
  if (v.values.cod === PERFIL_ADM) return res.status(400).json({ error: 'El código ADM está reservado.' });
  // Solo el ADM puede dar a un perfil acceso a todas las asociaciones.
  const todas = req.sis.esAdm ? v.values.todas : undefined;
  await pool.query(`UPDATE gt_perfiles SET cod_perfil = $1, desc_perfil = $2${todas === undefined ? '' : ', todas_asociaciones = $4'} WHERE id = $3`,
    todas === undefined ? [v.values.cod, v.values.desc, id] : [v.values.cod, v.values.desc, id, todas]);
  await logActivity(req.user.id, 'sistema_perfil_editado', { id }, req.ip);
  res.json({ id });
}));
router.put('/admin/perfiles/:id/opciones', exigir('perfiles'), guard(async (req, res) => {
  const id = parseId(req.params.id);
  const actual = (await pool.query('SELECT cod_perfil FROM gt_perfiles WHERE id = $1', [id])).rows[0];
  if (!actual) return res.status(404).json({ error: 'Perfil no encontrado.' });
  if (actual.cod_perfil === PERFIL_ADM) return res.status(400).json({ error: 'El perfil ADM siempre ve todo.' });
  const ids = Array.isArray(req.body && req.body.opciones) ? [...new Set(req.body.opciones.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : null;
  if (!ids) return res.status(400).json({ error: 'Faltan las opciones.' });
  // Las opciones de administracion (perfiles, items de menu) solo las puede repartir el ADM.
  if (!req.sis.esAdm) {
    const res2 = await pool.query("SELECT id FROM gt_submenu WHERE id = ANY($1::int[]) AND clave IN ('perfiles','menu')", [ids]);
    if (res2.rows.length) return res.status(403).json({ error: 'Solo el administrador puede dar acceso a Perfiles e Items menú.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM gt_perfil_opciones WHERE id_perfil = $1', [id]);
    await client.query('INSERT INTO gt_perfil_opciones (id_perfil, id_submenu) SELECT $1, s.id FROM gt_submenu s WHERE s.id = ANY($2::int[])', [id, ids]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await logActivity(req.user.id, 'sistema_perfil_opciones', { id, opciones: ids.length }, req.ip);
  res.json({ message: 'Opciones guardadas.' });
}));
router.delete('/admin/perfiles/:id', exigir('perfiles'), guard(async (req, res) => {
  const id = parseId(req.params.id);
  if ([1, 8, 9, 25].includes(id)) return res.status(400).json({ error: 'Los perfiles base del sistema no se eliminan.' });
  const u = (await pool.query('SELECT count(*)::int n FROM users WHERE id_perfil = $1', [id])).rows[0];
  if (u.n) return res.status(409).json({ error: `El perfil tiene ${u.n} usuario(s). Cámbiales el perfil primero.` });
  const r = await pool.query('DELETE FROM gt_perfiles WHERE id = $1 RETURNING id', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Perfil no encontrado.' });
  res.json({ message: 'Eliminado.' });
}));

// ---- Items menu (solo ADM por defecto): nombre y orden de menus y submenus ----
router.get('/admin/menu', exigir('menu'), guard(async (req, res) => {
  const items = (await pool.query('SELECT id, cod_item, descripcion FROM gt_menu ORDER BY cod_item')).rows;
  const subs = (await pool.query('SELECT id, id_menu, cod_item, descripcion, clave FROM gt_submenu ORDER BY cod_item, id')).rows;
  res.json({ items, subs });
}));
router.put('/admin/menu/:tipo/:id', exigir('menu'), guard(async (req, res) => {
  const tabla = req.params.tipo === 'item' ? 'gt_menu' : req.params.tipo === 'sub' ? 'gt_submenu' : null;
  if (!tabla) return res.status(404).json({ error: 'No encontrado.' });
  const desc = String((req.body && req.body.descripcion) || '').trim();
  const cod = Number(req.body && req.body.cod_item);
  if (!desc || desc.length > 120 || !Number.isInteger(cod) || cod < 0) return res.status(400).json({ error: 'Escribe la descripción y un orden (número entero).' });
  const r = await pool.query(`UPDATE ${tabla} SET descripcion = $1, cod_item = $2 WHERE id = $3 RETURNING id`, [desc, cod, parseId(req.params.id)]);
  if (!r.rows.length) return res.status(404).json({ error: 'No encontrado.' });
  await logActivity(req.user.id, 'sistema_menu_editado', { tabla, id: r.rows[0].id }, req.ip);
  res.json({ id: r.rows[0].id });
}));

// ---- Colaboradores: usuarios que entran al sistema (perfil, asociacion, bloqueo con mensaje) ----
// El ADM ve a todos; los demas ven a los usuarios de las asociaciones visibles y del equipo Genesis,
// pero nunca a los administradores (perfil ADM ni rol pro).
router.get('/admin/colaboradores', exigir('colaboradores'), guard(async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.id_perfil, p.cod_perfil, p.desc_perfil, u.activo, u.msg_login_desactivado,
            u.association_id, c.id AS id_centro, COALESCE(c.desc_centro, a.name) AS asociacion,
            to_char(u.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS creado
     FROM users u LEFT JOIN gt_perfiles p ON p.id = u.id_perfil LEFT JOIN associations a ON a.id = u.association_id
     LEFT JOIN tz_centros c ON c.association_id = u.association_id AND c.modulo = 'sistema'
     WHERE $1::boolean OR ((c.id = ANY($2::int[]) OR p.todas_asociaciones) AND u.role <> 'pro' AND p.cod_perfil <> 'ADM')
     ORDER BY asociacion, u.full_name`, [req.sis.esAdm, req.sis.idsCentros]);
  res.json(r.rows);
}));

// GET /sistema/admin/perfiles-asignables -> perfiles que este usuario puede asignar a un colaborador
router.get('/admin/perfiles-asignables', exigir('colaboradores'), guard(async (req, res) => {
  const r = await pool.query(
    `SELECT id, cod_perfil, desc_perfil, todas_asociaciones FROM gt_perfiles
     WHERE cod_perfil <> 'ADM' AND ($1::boolean OR NOT todas_asociaciones) ORDER BY id`, [req.sis.esAdm]);
  res.json(r.rows);
}));

// Valida y resuelve perfil + asociacion de un colaborador. Devuelve {errors} o {values}.
async function limpiarColaborador(req, b, nuevo) {
  const errors = [];
  const out = {};
  if (nuevo || b.full_name !== undefined) {
    out.full_name = String(b.full_name || '').trim();
    if (!out.full_name || out.full_name.length > 150) errors.push('Nombre obligatorio (máximo 150).');
  }
  if (nuevo || b.email !== undefined) {
    out.email = String(b.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email) || out.email.length > 150) errors.push('Correo inválido.');
  }
  if (b.phone !== undefined) out.phone = String(b.phone || '').trim().slice(0, 30) || null;
  if (b.activo !== undefined) out.activo = b.activo === true || b.activo === 'true';
  if (b.msg_login_desactivado !== undefined) out.msg_login_desactivado = String(b.msg_login_desactivado || '').trim().slice(0, 500) || null;
  if (nuevo || b.password) {
    const pw = String(b.password || '');
    if (pw.length < 8) errors.push('La contraseña debe tener al menos 8 caracteres.');
    else out.password_hash = await bcrypt.hash(pw, 10);
  }
  if (nuevo || b.id_perfil !== undefined) {
    const p = (await pool.query('SELECT id, cod_perfil, todas_asociaciones FROM gt_perfiles WHERE id = $1', [parseId(b.id_perfil)])).rows[0];
    if (!p) errors.push('Elige un perfil.');
    else if (p.cod_perfil === PERFIL_ADM) errors.push('El perfil Administrador no se asigna desde aquí.');
    else if (p.todas_asociaciones && !req.sis.esAdm) errors.push('Solo el administrador crea usuarios del equipo Genesis.');
    else {
      out.id_perfil = p.id;
      if (p.todas_asociaciones) out.association_id = ID_ASOC_GENESIS;
      else {
        const c = centroDestino(req, b.id_centro);
        if (!c) errors.push('Elige la asociación del usuario.');
        else out.association_id = req.sis.centros.find((x) => x.id === c).association_id;
      }
    }
  }
  return { errors, values: out };
}

router.post('/admin/colaboradores', exigir('colaboradores'), guard(async (req, res) => {
  const v = await limpiarColaborador(req, req.body || {}, true);
  if (v.errors.length) return sendErrores(res, v.errors);
  const d = { ...v.values, role: 'operativo', is_verified: true };
  const cols = Object.keys(d);
  try {
    const r = await pool.query(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, cols.map((c) => d[c]));
    await logActivity(req.user.id, 'sistema_colaborador_creado', { id: r.rows[0].id }, req.ip);
    res.json({ id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese correo.' });
    throw err;
  }
}));

router.put('/admin/colaboradores/:id', exigir('colaboradores'), guard(async (req, res) => {
  const id = parseId(req.params.id);
  const u = (await pool.query(
    `SELECT u.id, u.role, u.association_id, p.cod_perfil, p.todas_asociaciones FROM users u LEFT JOIN gt_perfiles p ON p.id = u.id_perfil WHERE u.id = $1`, [id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado.' });
  if (u.role === 'pro' || u.cod_perfil === PERFIL_ADM) return res.status(403).json({ error: 'Este usuario no se modifica desde aquí.' });
  if (!req.sis.esAdm) {
    const visible = u.todas_asociaciones || req.sis.centros.some((c) => c.association_id === u.association_id);
    if (!visible || u.todas_asociaciones) return res.status(403).json({ error: 'No puedes modificar este usuario.' });
  }
  if (id === req.user.id && req.body && req.body.activo === false) return res.status(400).json({ error: 'No puedes bloquearte a ti mismo.' });
  const v = await limpiarColaborador(req, req.body || {}, false);
  if (v.errors.length) return sendErrores(res, v.errors);
  const cols = Object.keys(v.values);
  if (!cols.length) return res.status(400).json({ error: 'Nada para actualizar.' });
  try {
    await pool.query(`UPDATE users SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`, cols.map((c) => v.values[c]).concat(id));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese correo.' });
    throw err;
  }
  await logActivity(req.user.id, 'sistema_colaborador_editado', { id, campos: cols.filter((c) => c !== 'password_hash').concat(v.values.password_hash ? ['password'] : []) }, req.ip);
  res.json({ id });
}));

// ---- Cambio password: el usuario cambia la suya (pide la actual) ----
router.post('/password', exigir('cambio_password'), guard(async (req, res) => {
  const { actual, nueva } = req.body || {};
  if (typeof actual !== 'string' || typeof nueva !== 'string') return res.status(400).json({ error: 'Escribe la contraseña actual y la nueva.' });
  if (nueva.length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
  const u = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!u || !(await bcrypt.compare(actual, u.password_hash))) return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(nueva, 10), req.user.id]);
  await logActivity(req.user.id, 'sistema_password_cambiada', {}, req.ip);
  res.json({ message: 'Contraseña actualizada.' });
}));

module.exports = router;
