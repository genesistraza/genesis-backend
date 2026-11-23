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
// Campos que tenia cada pantalla en el sistema original (App_Data/*.xml, gridColsIns): en Registro solo
// se muestran y se escriben estos. Los demas campos de la tabla (los agrego Pruebas para el SUI) quedan
// fuera de esta pantalla. Una pantalla que no esta aqui muestra todos sus campos.
const CAMPOS_ORIGINAL = {
  recicladores: ['id_centro', 'nro_documento', 'nombre_completo', 'estado', 'fecha_exp_documento', 'fecha_nacimiento', 'direccion', 'telefono', 'tipo_de_vehiculo', 'placa'],
  numacros: ['id_centro', 'id_localidad', 'cod_numacro'],
  localidades: ['desc_localidad', 'ciudad'],
  tipos_material: ['cod_tipo_material', 'desc_familia', 'desc_tipo_material'],
  centros: ['cod_centro', 'desc_centro', 'link_dashboard'],
  usuarios: ['id_centro', 'id_numacro', 'nuis_nuid', 'direccion_usuario', 'id_usuario_uso', 'id_usuario_tipo', 'id_usuario_multiusuario'],
  microrrutas_detalle: ['id_formulario_microrruta', 'desc_microrruta', 'id_tipo_microrruta', 'direccion_inicio', 'hora_inicio', 'direccion_finalizacion', 'hora_finalizacion',
    'distancia_via_no_pavimentada', 'distancia_via_pavimentada', 'frecuencia_semanal', 'dias_frecuencia', 'id_estacion_transferencia'],
  aprovechamiento: ['id_centro', 'periodo', 'id_usuario', 'id_numacro', 'toneladas'],
  recursos: ['id_centro', 'fecha', 'nuap', 'operador', 'valor'],
  bodegas: ['id_centro', 'cod_bodega', 'desc_bodega', 'direccion', 'desc_ubicacion', 'fecha_inicio_operaciones']
};
// ECAs: una asociacion puede tener varias (pantalla "ECAs"). A cada trabajador se le dice a cuales
// tiene acceso (gt_usuario_ecas); sin ninguna marcada = todas las de su asociacion.
const ecaPermitida = (req, idBodega) => !req.sis.ecas || req.sis.ecas.includes(Number(idBodega));

// Campos obligatorios de la tabla que el original no pedia: valor fijo al crear.
async function valoresPorDefecto(key) {
  if (key === 'recicladores') {
    // El sistema original solo manejaba cedula (la factura dice "C.C."): tipo de identificacion = CC.
    const cc = (await pool.query("SELECT id FROM tz_catalogos WHERE categoria = 'tipos_identificacion' AND codigo = '1'")).rows[0];
    return cc ? { id_tipo_identificacion: cc.id } : {};
  }
  return {};
}
const campoOriginal = (key, nombre) => !own(CAMPOS_ORIGINAL, key) || CAMPOS_ORIGINAL[key].includes(nombre);
// Deja en el cuerpo solo los campos del original (el resto no se puede escribir desde Registro).
function soloOriginales(key, body) {
  if (!own(CAMPOS_ORIGINAL, key)) return body;
  const out = {};
  for (const k of Object.keys(body)) if (CAMPOS_ORIGINAL[key].includes(k)) out[k] = body[k];
  return out;
}

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
    `SELECT u.id, u.full_name, u.email, u.role, u.association_id, u.activo, u.msg_login_desactivado, u.foto_url,
            p.id AS id_perfil, p.cod_perfil, p.desc_perfil, p.todas_asociaciones, p.permisos_por_usuario
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

  // Trabajadores de la asociacion: sus opciones y lo que pueden hacer en cada una las decide la
  // asociacion, persona por persona. Los demas perfiles pueden todo en las opciones de su perfil.
  let claves, acciones = null;
  if (esAdm) claves = (await pool.query('SELECT clave FROM gt_submenu')).rows.map((r) => r.clave);
  else if (u.permisos_por_usuario) {
    const r = (await pool.query(
      `SELECT s.clave, p.crear, p.editar, p.borrar FROM gt_usuario_permisos p JOIN gt_submenu s ON s.id = p.id_submenu WHERE p.user_id = $1`, [u.id])).rows;
    claves = r.map((x) => x.clave);
    acciones = Object.fromEntries(r.map((x) => [x.clave, { crear: x.crear, editar: x.editar, borrar: x.borrar }]));
  } else {
    claves = (await pool.query('SELECT s.clave FROM gt_perfil_opciones o JOIN gt_submenu s ON s.id = o.id_submenu WHERE o.id_perfil = $1', [u.id_perfil])).rows.map((r) => r.clave);
  }

  // ECAs a las que tiene acceso el trabajador (null = todas)
  let ecas = null;
  if (acciones) {
    const e = (await pool.query('SELECT id_bodega FROM gt_usuario_ecas WHERE user_id = $1', [u.id])).rows.map((x) => x.id_bodega);
    if (e.length) ecas = e;
  }
  req.sis = { usuario: u, esAdm, todas, centros, idsCentros: centros.map((c) => c.id), claves: new Set(claves), acciones, ecas };
  next();
}));

const tiene = (req, clave) => req.sis.claves.has(own(PERMISO_DE, clave) ? PERMISO_DE[clave] : clave);
// ¿Puede crear / editar / borrar en esa opcion? (siempre si no es trabajador con permisos propios)
function puede(req, clave, accion) {
  if (!tiene(req, clave)) return false;
  if (!req.sis.acciones) return true;
  const a = req.sis.acciones[own(PERMISO_DE, clave) ? PERMISO_DE[clave] : clave];
  return !!(a && a[accion]);
}
const NO_PUEDE = { crear: 'Tu usuario no tiene permiso para registrar en esta opción.', editar: 'Tu usuario no tiene permiso para modificar en esta opción.', borrar: 'Tu usuario no tiene permiso para borrar en esta opción.' };
function exigirAccion(clave, accion) {
  return (req, res, next) => (puede(req, clave, accion) ? next() : res.status(403).json({ error: NO_PUEDE[accion] }));
}
function exigir(clave) {
  return (req, res, next) => (tiene(req, clave) ? next() : res.status(403).json({ error: 'Tu perfil no tiene acceso a esta opción.' }));
}
function exigirAlguna(claves) {
  return (req, res, next) => (claves.some((c) => tiene(req, c)) ? next() : res.status(403).json({ error: 'Tu perfil no tiene acceso a esta opción.' }));
}

function etiquetaSesion(s) {
  if (s.esAdm) return 'Fundador';
  if (s.todas) return 'Asesor / Administrador';
  return 'Asociación: ' + (s.centros[0] ? s.centros[0].desc_centro : '');
}

// GET /sistema/me -> perfil, asociacion(es) visibles, foto, permisos y etiqueta de la barra de titulo
router.get('/me', (req, res) => {
  const s = req.sis;
  res.json({
    id: s.usuario.id, nombre: s.usuario.full_name, perfil: s.usuario.cod_perfil, descPerfil: s.usuario.desc_perfil, esAdm: s.esAdm,
    esTrabajador: !!s.acciones, foto: s.usuario.foto_url || null, acciones: s.acciones,
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
// Nombres que se ven en Registro (los de Pruebas quedan igual).
const ETIQUETAS_REGISTRO = { bodegas: { id_centro: 'Asociación', cod_bodega: 'Número ECA (NUECA)', desc_bodega: 'Nombre de la ECA', desc_ubicacion: 'Barrio / ubicación' } };
function camposVisibles(req, key, entity) {
  const et = ETIQUETAS_REGISTRO[key] || {};
  return entity.fields.map((f) => (et[f.name] ? Object.assign({}, f, { label: et[f.name] }) : f)).filter((f) => campoOriginal(key, f.name) && (req.sis.todas || f.name !== 'id_centro') && (req.sis.todas || key !== 'centros' || !SOLO_ADMIN.has(f.name)));
}

// GET /sistema/entidades -> metadata de campos de las pantallas permitidas (para armar tablas y formularios)
router.get('/entidades', (req, res) => {
  const out = {};
  for (const clave in CLAVE_ENTIDAD) {
    if (!tiene(req, clave)) continue;
    const key = CLAVE_ENTIDAD[clave], e = ENTITIES[key];
    const acc = { crear: puede(req, clave, 'crear'), editar: puede(req, clave, 'editar'), borrar: puede(req, clave, 'borrar') };
    const escribe = puedeEscribir(req, key, e);
    out[clave] = { label: e.label, fields: camposVisibles(req, key, e), soloLectura: !escribe || !(acc.crear || acc.editar || acc.borrar),
      acciones: escribe ? acc : { crear: false, editar: false, borrar: false } };
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
  res.json(req.params.entidad === 'bodegas' && req.sis.ecas ? r.rows.filter((x) => ecaPermitida(req, x.value)) : r.rows);
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
  // Trabajador con ECAs asignadas: solo esas ECAs y el balance registrado en ellas.
  if (req.sis.ecas && (key === 'bodegas' || key === 'balance_masas')) {
    params.push(req.sis.ecas);
    filtros.push((key === 'bodegas' ? 't.id' : 't.id_bodega') + ' = ANY($' + params.length + '::int[])');
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
  const fila = r.rows[0] || null;
  if (fila && req.sis.ecas && ((key === 'bodegas' && !ecaPermitida(req, fila.id)) || (key === 'balance_masas' && !ecaPermitida(req, fila.id_bodega)))) return null;
  return fila;
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
  if (!puedeEscribir(req, key, entity) || !puede(req, req.params.clave, 'crear')) return res.status(403).json({ error: !puedeEscribir(req, key, entity) ? 'Esta tabla es de solo lectura para tu perfil.' : NO_PUEDE.crear });
  const body = { ...(await valoresPorDefecto(key)), ...soloOriginales(key, { ...(req.body || {}) }) };
  if (entity.fields.some((f) => f.name === 'id_centro')) {
    const c = centroDestino(req, body.id_centro);
    if (!c) return res.status(400).json({ error: 'Elige una asociación válida.' });
    body.id_centro = c;
  }
  if (key === 'microrrutas_detalle' && !(await microrrutaVisible(req, body.id_formulario_microrruta))) {
    return res.status(400).json({ error: 'La microrruta no existe o es de otra asociación.' });
  }
  if (req.sis.ecas && key === 'bodegas') return res.status(403).json({ error: 'Tu usuario solo maneja las ECAs que le asignaron; no puede crear ECAs nuevas.' });
  if (key === 'bodegas') {
    // Tope de ECAs de la asociacion (lo pone el fundador o el asesor en el panel de administracion).
    const lim = (await pool.query(
      `SELECT a.max_ecas, (SELECT count(*)::int FROM tz_bodegas b JOIN tz_centros c2 ON c2.id = b.id_centro WHERE c2.association_id = a.id) AS usadas
       FROM tz_centros c JOIN associations a ON a.id = c.association_id WHERE c.id = $1`, [body.id_centro])).rows[0];
    if (lim && lim.usadas >= lim.max_ecas) {
      return res.status(403).json({ error: `Esta asociación puede tener ${lim.max_ecas} ECA${lim.max_ecas === 1 ? '' : 's'} y ya ${lim.usadas === 1 ? 'tiene 1' : 'tiene ' + lim.usadas}. Para crear más, pídele a Genesis que amplíe el cupo.` });
    }
  }
  if (req.sis.ecas && key === 'balance_masas' && !ecaPermitida(req, body.id_bodega)) return res.status(403).json({ error: 'Elige una de las ECAs que tienes asignadas.' });
  const v = await validateRecord(ENTITIES, key, body);
  if (v.errors.length) return sendErrores(res, v.errors);
  let datos = v.values;
  if (key === 'balance_masas') datos = { ...datos, creado_por: req.user.id, origen: 'manual' };
  if (key === 'centros') datos = { ...datos, modulo: 'sistema', pct_rechazo_estimado: 1.8 };
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
  if (!puedeEscribir(req, key, entity) || !puede(req, req.params.clave, 'editar')) return res.status(403).json({ error: !puedeEscribir(req, key, entity) ? 'Esta tabla es de solo lectura para tu perfil.' : NO_PUEDE.editar });
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id inválido.' });
  const actual = await filaVisible(req, key, entity, id);
  if (!actual) return res.status(404).json({ error: 'Registro no encontrado.' });
  const body = quitarReservados(req, key, soloOriginales(key, { ...(req.body || {}) }));
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
  if (!puedeEscribir(req, key, entity) || !puede(req, req.params.clave, 'borrar')) return res.status(403).json({ error: !puedeEscribir(req, key, entity) ? 'Esta tabla es de solo lectura para tu perfil.' : NO_PUEDE.borrar });
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

// ============================== Precios materiales ==============================
// Precio fijo por kg de cada material para la asociacion. El formulario de balance de masas lo pone
// solo al escribir los kilos; en cada compra se puede cambiar.

function centroDePrecios(req, valor) {
  if (!req.sis.todas) return req.sis.idsCentros[0];
  const n = Number(valor);
  return req.sis.idsCentros.includes(n) ? n : null;
}

// GET /sistema/precios?id_centro=X -> todos los materiales con su precio fijo (o vacio)
router.get('/precios', exigir('precios_material'), guard(async (req, res) => {
  const idCentro = centroDePrecios(req, req.query.id_centro);
  if (!idCentro) return res.status(400).json({ error: 'Elige una asociación.' });
  const r = await pool.query(
    `SELECT tm.id AS id_tipo_material, tm.cod_tipo_material, tm.desc_tipo_material, tm.desc_familia, p.precio,
            to_char(p.updated_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS actualizado
     FROM tz_tipos_material tm LEFT JOIN gt_precios_material p ON p.id_tipo_material = tm.id AND p.id_centro = $1
     ORDER BY tm.secuencia_orden, tm.desc_tipo_material`, [idCentro]);
  res.json(r.rows);
}));

// PUT /sistema/precios {id_centro, id_tipo_material, precio} -> guarda (precio vacio = quitar el precio fijo)
router.put('/precios', exigirAccion('precios_material', 'editar'), guard(async (req, res) => {
  const b = req.body || {};
  const idCentro = centroDePrecios(req, b.id_centro);
  if (!idCentro) return res.status(400).json({ error: 'Elige una asociación.' });
  const mat = (await pool.query('SELECT id FROM tz_tipos_material WHERE id = $1', [parseId(b.id_tipo_material)])).rows[0];
  if (!mat) return res.status(400).json({ error: 'Material inválido.' });
  if (b.precio === null || b.precio === undefined || b.precio === '') {
    await pool.query('DELETE FROM gt_precios_material WHERE id_centro = $1 AND id_tipo_material = $2', [idCentro, mat.id]);
    return res.json({ message: 'Precio quitado.' });
  }
  const precio = Number(String(b.precio).replace(',', '.'));
  if (!Number.isFinite(precio) || precio < 0 || precio > 99999999) return res.status(400).json({ error: 'El precio debe ser un número entre 0 y 99.999.999.' });
  await pool.query(
    `INSERT INTO gt_precios_material (id_centro, id_tipo_material, precio, user_id, updated_at) VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (id_centro, id_tipo_material) DO UPDATE SET precio = EXCLUDED.precio, user_id = EXCLUDED.user_id, updated_at = NOW()`,
    [idCentro, mat.id, Math.round(precio * 100) / 100, req.user.id]);
  await logActivity(req.user.id, 'sistema_precio_material', { id_centro: idCentro, id_tipo_material: mat.id, precio }, req.ip);
  res.json({ message: 'Guardado.' });
}));

// ============================== Formulario balance de masas ==============================
// Mismo formulario de Pruebas (un reciclador, un dia, una fila por material), acotado a la asociacion.

// GET /sistema/bm/contexto -> recicladores de las asociaciones visibles y materiales
router.get('/bm/contexto', exigir('balance_masas'), guard(async (req, res) => {
  const rec = await pool.query(
    `SELECT r.id, r.id_centro, c.desc_centro AS id_centro_label, r.nombre_completo, r.nro_documento, r.tipo_de_vehiculo, r.placa,
            COALESCE(c.pct_rechazo_estimado, 0)::float AS pct_rechazo
     FROM tz_recicladores r JOIN tz_centros c ON c.id = r.id_centro WHERE r.id_centro = ANY($1::int[]) ORDER BY r.nombre_completo`, [req.sis.idsCentros]);
  const mat = await pool.query('SELECT id, cod_tipo_material, desc_tipo_material, desc_familia, secuencia_orden FROM tz_tipos_material ORDER BY secuencia_orden, desc_tipo_material');
  // Precios fijos por asociacion: { id_centro: { id_tipo_material: precio } }
  const pr = await pool.query('SELECT id_centro, id_tipo_material, precio::float AS precio FROM gt_precios_material WHERE id_centro = ANY($1::int[])', [req.sis.idsCentros]);
  const precios = {};
  pr.rows.forEach((p) => { (precios[p.id_centro] = precios[p.id_centro] || {})[p.id_tipo_material] = p.precio; });
  res.json({ recicladores: rec.rows, materiales: mat.rows, precios });
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
    pool.query('SELECT id, cod_bodega, desc_bodega FROM tz_bodegas WHERE id_centro = $1 AND ($2::int[] IS NULL OR id = ANY($2::int[])) ORDER BY cod_bodega', [rec.id_centro, req.sis.ecas]),
    // Numacros de la asociacion (pantalla Numacros Asociaciones/Localidades), como en el sistema original.
    pool.query(`SELECT n.id, n.cod_numacro, l.desc_localidad FROM tz_numacros n LEFT JOIN tz_localidades l ON l.id = n.id_localidad
                WHERE n.id_centro = $1 ORDER BY n.cod_numacro`, [rec.id_centro]),
    pool.query(`SELECT d.id, d.desc_microrruta FROM tz_formulario_microrrutas_detalle d JOIN tz_formulario_microrrutas f ON f.id = d.id_formulario_microrruta
                WHERE f.id_centro = $1 AND (f.id_reciclador = $2 OR f.id_reciclador IS NULL) ORDER BY d.id`, [rec.id_centro, rec.id])
  ]);
  res.json({ bodegas: b.rows, numacros: m.rows, microrrutas: d.rows });
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
            b.cod_bodega, b.desc_bodega, m.cod_macrorruta, m.desc_macrorruta, nm.cod_numacro, nl.desc_localidad AS numacro_localidad,
            d1.desc_microrruta AS micro1, d2.desc_microrruta AS micro2
     FROM tz_formulario_balance_masas bm
     LEFT JOIN tz_tipos_material tm ON tm.id = bm.id_tipo_material
     LEFT JOIN tz_bodegas b ON b.id = bm.id_bodega LEFT JOIN tz_macrorrutas m ON m.id = bm.id_macrorruta
     LEFT JOIN tz_numacros nm ON nm.id = bm.id_numacro LEFT JOIN tz_localidades nl ON nl.id = nm.id_localidad
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
    operacion: { eca: combo(f0.cod_bodega, f0.desc_bodega), macrorruta: combo(f0.cod_numacro, f0.numacro_localidad) || combo(f0.cod_macrorruta, f0.desc_macrorruta), micro1: f0.micro1, micro2: f0.micro2 },
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
  if (req.sis.ecas && !ecaPermitida(req, req.body.id_bodega)) { res.status(403).json({ error: 'Elige la ECA donde se recibió el material (una de las que tienes asignadas).' }); return false; }
  // Rechazo vacio (null o '') -> porcentaje fijo de la asociacion sobre los kilos, marcado como
  // estimado. Si el usuario escribio un valor (aunque sea 0), se respeta tal cual.
  const pct = Number((await pool.query('SELECT pct_rechazo_estimado FROM tz_centros WHERE id = $1', [rec.id_centro])).rows[0].pct_rechazo_estimado) || 0;
  if (Array.isArray(req.body.materiales)) {
    req.body.materiales = req.body.materiales.map((m) => {
      const vacio = !m || m.cantidad_rechazo === null || m.cantidad_rechazo === undefined || m.cantidad_rechazo === '';
      const kg = Number(m && m.cantidad);
      if (vacio && pct > 0 && Number.isFinite(kg) && kg > 0) {
        return { ...m, cantidad_rechazo: Math.round(kg * pct) / 100, rechazo_estimado: true };
      }
      return { ...m, rechazo_estimado: false };
    });
  }
  return true;
}
router.post('/bm/dia', exigir('balance_masas'), guard(async (req, res, next) => {
  if (!(await prepararDia(req, res))) return;
  if (req.sis.acciones) {
    const ya = (await pool.query('SELECT count(*)::int n FROM tz_formulario_balance_masas WHERE id_reciclador = $1 AND fecha = $2', [Number(req.body.id_reciclador), String(req.body.fecha || '')])).rows[0].n;
    const vacio = !Array.isArray(req.body.materiales) || !req.body.materiales.some((m) => Number(m.cantidad) || Number(m.valor) || Number(m.cantidad_rechazo) || Number(m.cantidad_nosui));
    const accion = ya && vacio ? 'borrar' : (ya && String(req.body.fecha) < todayCO() ? 'editar' : 'crear');
    if (!puede(req, 'balance_masas', accion)) return res.status(403).json({ error: accion === 'editar' ? 'Tu usuario puede registrar material, pero no modificar días anteriores que ya estaban registrados.' : NO_PUEDE[accion] });
  }
  return HANDLERS.bmDiaPost(req, res, next);
}));
router.post('/bm/anexar', exigirAccion('balance_masas', 'crear'), guard(async (req, res, next) => {
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
  const buffer = await plantillaEntidad(c.entidad, getEntity(c.entidad), { idsCentros: req.sis.idsCentros, sinCentro: !req.sis.todas, sinHora: true, soloCampos: CAMPOS_ORIGINAL[c.entidad] });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_' + req.params.tipo + '.xlsx"');
  res.send(buffer);
}));

// POST /sistema/importar/:tipo (archivo) -> crea filas nuevas y registra el cargue
router.post('/importar/:tipo', exigirAccion('importar', 'crear'), uploadExcel.single('file'), guard(async (req, res) => {
  const c = tipoCargue(req, res); if (!c) return;
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo.' });
  const entity = getEntity(c.entidad);
  // Campos que no estaban en el original: no se leen del archivo (vacios, o su valor fijo si son obligatorios).
  const fijos = req.sis.todas ? {} : { id_centro: req.sis.idsCentros[0] };
  for (const f of entity.fields) if (!campoOriginal(c.entidad, f.name) && !f.required) fijos[f.name] = null;
  Object.assign(fijos, await valoresPorDefecto(c.entidad));
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
  if (!puede(req, req.params.clave, 'borrar')) return res.status(403).json({ error: NO_PUEDE.borrar });
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
  if (!puede(req, 'documentos_asociaciones', actual ? 'editar' : 'crear')) return res.status(403).json({ error: NO_PUEDE[actual ? 'editar' : 'crear'] });
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

router.delete('/documentos/asociaciones/:id', exigirAccion('documentos_asociaciones', 'borrar'), guard(async (req, res) => {
  const r = await pool.query("DELETE FROM gt_documentos WHERE id = $1 AND grupo = 'asociacion' AND id_centro = ANY($2::int[]) RETURNING id", [parseId(req.params.id), req.sis.idsCentros]);
  if (!r.rows.length) return res.status(404).json({ error: 'Documento no encontrado.' });
  await logActivity(req.user.id, 'sistema_documento_eliminado', { id: r.rows[0].id }, req.ip);
  res.json({ message: 'Eliminado.' });
}));

// GET /sistema/documentos/:id/descargar -> descarga el archivo (con su nombre original). Cloudinary no
// deja abrir PDFs por enlace publico, asi que el servidor lo pide con una URL firmada y lo reenvia.
router.get('/documentos/:id/descargar', guard(async (req, res) => {
  const d = (await pool.query('SELECT id, grupo, id_centro, nombre, archivo_url FROM gt_documentos WHERE id = $1', [parseId(req.params.id)])).rows[0];
  const visible = d && (d.grupo === 'referencia' ? tiene(req, 'documentos_referencia') : (tiene(req, 'documentos_asociaciones') && req.sis.idsCentros.includes(d.id_centro)));
  if (!visible) return res.status(404).json({ error: 'Documento no encontrado.' });
  const m = /\/(image|raw|video)\/upload\/(?:v\d+\/)?(.+)$/.exec(d.archivo_url);
  if (!m) return res.status(500).json({ error: 'No se pudo ubicar el archivo.' });
  const tipo = m[1];
  let publicId = decodeURIComponent(m[2]), formato = '';
  if (tipo !== 'raw') { const p = /^(.+)\.([a-z0-9]+)$/i.exec(publicId); if (p) { publicId = p[1]; formato = p[2]; } }
  const url = cloudinary.utils.private_download_url(publicId, formato, { resource_type: tipo, type: 'upload' });
  const r = await fetch(url);
  if (!r.ok) return res.status(502).json({ error: 'No se pudo descargar el archivo del almacenamiento.' });
  const ext = (/\.([a-z0-9]+)$/i.exec(d.archivo_url) || [])[1] || formato || '';
  let nombre = String(d.nombre || 'documento').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim();
  if (ext && !nombre.toLowerCase().endsWith('.' + ext.toLowerCase())) nombre += '.' + ext;
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition'); // la pagina (otro dominio) lee el nombre
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(nombre)}`);
  res.send(Buffer.from(await r.arrayBuffer()));
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
    `SELECT u.id, u.full_name, u.email, u.phone, u.id_perfil, p.cod_perfil, p.desc_perfil, u.activo, u.msg_login_desactivado, u.foto_url,
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

// ============================== Trabajadores de la asociacion ==============================
// La asociacion crea a sus trabajadores (perfil EMPLEADOS) y decide, opcion por opcion, si pueden
// ver, crear, editar o borrar. El asesor (Colaboradores) tambien puede manejarlos.
const PERFIL_TRABAJADOR = 25;
const CLAVES_NO_ASIGNABLES = new Set(['perfiles', 'menu', 'colaboradores', 'trabajadores', 'sql_archivos']);
const gestionaTrabajadores = (req) => tiene(req, 'trabajadores') || tiene(req, 'colaboradores');
const exigirGestor = (req, res, next) => (gestionaTrabajadores(req) && !req.sis.acciones ? next() : res.status(403).json({ error: 'Tu perfil no puede manejar trabajadores.' }));

// Trabajador visible para quien lo administra (de una de sus asociaciones), o null.
async function trabajadorVisible(req, id) {
  const r = await pool.query(
    `SELECT u.id, u.association_id FROM users u JOIN tz_centros c ON c.association_id = u.association_id AND c.modulo = 'sistema'
     WHERE u.id = $1 AND u.id_perfil = $2 AND c.id = ANY($3::int[])`, [parseId(id), PERFIL_TRABAJADOR, req.sis.idsCentros]);
  return r.rows[0] || null;
}

// GET /sistema/trabajadores -> trabajadores de las asociaciones visibles, con sus permisos
router.get('/trabajadores', exigirGestor, guard(async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.activo, u.msg_login_desactivado, u.foto_url, c.id AS id_centro, c.desc_centro AS asociacion,
            to_char(u.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS creado,
            COALESCE((SELECT json_agg(json_build_object('id_submenu', p.id_submenu, 'crear', p.crear, 'editar', p.editar, 'borrar', p.borrar))
                      FROM gt_usuario_permisos p WHERE p.user_id = u.id), '[]') AS permisos,
            COALESCE((SELECT json_agg(e.id_bodega) FROM gt_usuario_ecas e WHERE e.user_id = u.id), '[]') AS ecas
     FROM users u JOIN tz_centros c ON c.association_id = u.association_id AND c.modulo = 'sistema'
     WHERE u.id_perfil = $1 AND c.id = ANY($2::int[]) ORDER BY c.desc_centro, u.full_name`, [PERFIL_TRABAJADOR, req.sis.idsCentros]);
  res.json(r.rows);
}));

// GET /sistema/trabajadores/opciones -> opciones del menu que se le pueden dar a un trabajador
// (solo las que tiene quien lo crea, sin las de administracion).
router.get('/trabajadores/opciones', exigirGestor, guard(async (req, res) => {
  const r = await pool.query('SELECT s.id, s.descripcion, s.clave, m.descripcion AS menu FROM gt_submenu s JOIN gt_menu m ON m.id = s.id_menu ORDER BY m.cod_item, s.cod_item, s.id');
  res.json(r.rows.filter((x) => req.sis.claves.has(x.clave) && !CLAVES_NO_ASIGNABLES.has(x.clave)));
}));

async function datosTrabajador(req, b, nuevo) {
  const errors = [], out = {};
  if (nuevo || b.full_name !== undefined) { out.full_name = String(b.full_name || '').trim(); if (!out.full_name || out.full_name.length > 150) errors.push('Nombre obligatorio (máximo 150).'); }
  if (nuevo || b.email !== undefined) { out.email = String(b.email || '').trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email) || out.email.length > 150) errors.push('Correo inválido.'); }
  if (b.phone !== undefined) out.phone = String(b.phone || '').trim().slice(0, 30) || null;
  if (b.activo !== undefined) out.activo = b.activo === true || b.activo === 'true';
  if (b.msg_login_desactivado !== undefined) out.msg_login_desactivado = String(b.msg_login_desactivado || '').trim().slice(0, 500) || null;
  if (nuevo || b.password) {
    const pw = String(b.password || '');
    if (pw.length < 8) errors.push('La contraseña debe tener al menos 8 caracteres.'); else out.password_hash = await bcrypt.hash(pw, 10);
  }
  if (nuevo) {
    const c = centroDestino(req, b.id_centro);
    if (!c) errors.push('Elige la asociación.'); else out.association_id = req.sis.centros.find((x) => x.id === c).association_id;
  }
  return { errors, values: out };
}

// ECAs que se le pueden dar al trabajador: las de su asociacion. Devuelve la lista limpia o un error.
async function ecasValidas(associationId, lista) {
  if (lista === undefined) return { ids: undefined };
  if (!Array.isArray(lista)) return { error: 'Las ECAs vienen mal.' };
  const ids = [...new Set(lista.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return { ids };
  const ok = (await pool.query(
    `SELECT b.id FROM tz_bodegas b JOIN tz_centros c ON c.id = b.id_centro WHERE b.id = ANY($1::int[]) AND c.association_id = $2`, [ids, associationId])).rows;
  if (ok.length !== ids.length) return { error: 'Una de las ECAs no es de la asociación del trabajador.' };
  return { ids };
}
async function guardarEcasTrabajador(userId, ids) {
  if (ids === undefined) return;
  await pool.query('DELETE FROM gt_usuario_ecas WHERE user_id = $1', [userId]);
  for (const id of ids) await pool.query('INSERT INTO gt_usuario_ecas (user_id, id_bodega) VALUES ($1,$2)', [userId, id]);
}

// GET /sistema/trabajadores/ecas -> ECAs de las asociaciones visibles (para escoger a cuales tiene acceso)
router.get('/trabajadores/ecas', exigirGestor, guard(async (req, res) => {
  const r = await pool.query(
    `SELECT b.id, b.id_centro, b.cod_bodega, b.desc_bodega FROM tz_bodegas b WHERE b.id_centro = ANY($1::int[]) ORDER BY b.cod_bodega, b.id`, [req.sis.idsCentros]);
  res.json(r.rows);
}));

// POST /sistema/trabajadores -> crea un trabajador (sin opciones: luego se le dan sus permisos)
router.post('/trabajadores', exigirGestor, guard(async (req, res) => {
  const v = await datosTrabajador(req, req.body || {}, true);
  if (v.errors.length) return sendErrores(res, v.errors);
  const ev = await ecasValidas(v.values.association_id, (req.body || {}).ecas);
  if (ev.error) return res.status(400).json({ error: ev.error });
  const d = { ...v.values, role: 'operativo', is_verified: true, id_perfil: PERFIL_TRABAJADOR };
  const cols = Object.keys(d);
  try {
    const r = await pool.query(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, cols.map((c) => d[c]));
    await guardarEcasTrabajador(r.rows[0].id, ev.ids);
    await logActivity(req.user.id, 'sistema_trabajador_creado', { id: r.rows[0].id, nombre: d.full_name }, req.ip);
    res.json({ id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese correo.' });
    throw err;
  }
}));

// PUT /sistema/trabajadores/:id -> datos, clave, bloqueo
router.put('/trabajadores/:id', exigirGestor, guard(async (req, res) => {
  const t = await trabajadorVisible(req, req.params.id);
  if (!t) return res.status(404).json({ error: 'Trabajador no encontrado.' });
  const v = await datosTrabajador(req, req.body || {}, false);
  if (v.errors.length) return sendErrores(res, v.errors);
  const ev = await ecasValidas(t.association_id, (req.body || {}).ecas);
  if (ev.error) return res.status(400).json({ error: ev.error });
  const cols = Object.keys(v.values);
  if (!cols.length && ev.ids === undefined) return res.status(400).json({ error: 'Nada para actualizar.' });
  try {
    if (cols.length) await pool.query(`UPDATE users SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`, cols.map((c) => v.values[c]).concat(t.id));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese correo.' });
    throw err;
  }
  await guardarEcasTrabajador(t.id, ev.ids);
  await logActivity(req.user.id, 'sistema_trabajador_editado', { id: t.id, campos: cols.filter((c) => c !== 'password_hash') }, req.ip);
  res.json({ id: t.id });
}));

// PUT /sistema/trabajadores/:id/permisos {permisos:[{id_submenu, crear, editar, borrar}]} -> reemplaza sus permisos
router.put('/trabajadores/:id/permisos', exigirGestor, guard(async (req, res) => {
  const t = await trabajadorVisible(req, req.params.id);
  if (!t) return res.status(404).json({ error: 'Trabajador no encontrado.' });
  const lista = Array.isArray(req.body && req.body.permisos) ? req.body.permisos : null;
  if (!lista) return res.status(400).json({ error: 'Faltan los permisos.' });
  const permitidas = new Map((await pool.query('SELECT id, clave FROM gt_submenu')).rows
    .filter((x) => req.sis.claves.has(x.clave) && !CLAVES_NO_ASIGNABLES.has(x.clave)).map((x) => [x.id, x.clave]));
  const filas = [];
  for (const p of lista) {
    const id = Number(p && p.id_submenu);
    if (!permitidas.has(id)) return res.status(400).json({ error: 'Una de las opciones no se puede asignar.' });
    filas.push([id, p.crear === true, p.editar === true, p.borrar === true]);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM gt_usuario_permisos WHERE user_id = $1', [t.id]);
    for (const [id, c, e, b] of filas) {
      await client.query('INSERT INTO gt_usuario_permisos (user_id, id_submenu, crear, editar, borrar) VALUES ($1,$2,$3,$4,$5)', [t.id, id, c, e, b]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await logActivity(req.user.id, 'sistema_trabajador_permisos', { id: t.id, opciones: filas.length }, req.ip);
  res.json({ message: 'Permisos guardados.' });
}));

// ============================== Fotos de las personas ==============================
const uploadFoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
// Puede cambiar la foto: la misma persona, quien administra a ese trabajador, o el asesor/fundador
// para los usuarios que puede ver en Colaboradores.
async function puedeCambiarFoto(req, id) {
  if (id === req.user.id) return true;
  if (req.sis.acciones) return false;
  if (gestionaTrabajadores(req) && await trabajadorVisible(req, id)) return true;
  if (tiene(req, 'colaboradores')) {
    const u = (await pool.query(
      `SELECT u.role, p.cod_perfil, c.id AS id_centro, p.todas_asociaciones FROM users u LEFT JOIN gt_perfiles p ON p.id = u.id_perfil
       LEFT JOIN tz_centros c ON c.association_id = u.association_id AND c.modulo = 'sistema' WHERE u.id = $1`, [id])).rows[0];
    if (!u) return false;
    if (req.sis.esAdm) return true;
    return u.role !== 'pro' && u.cod_perfil !== PERFIL_ADM && (u.todas_asociaciones || req.sis.idsCentros.includes(u.id_centro));
  }
  return false;
}
// POST /sistema/usuarios/:id/foto (archivo) -> sube la foto (cuadrada, centrada en la cara)
router.post('/usuarios/:id/foto', uploadFoto.single('file'), guard(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id || !(await puedeCambiarFoto(req, id))) return res.status(403).json({ error: 'No puedes cambiar la foto de este usuario.' });
  if (!req.file || !/^image\/(jpeg|png|webp)$/.test(req.file.mimetype)) return res.status(400).json({ error: 'Sube una foto en JPG, PNG o WEBP (máximo 5 MB).' });
  const url = await new Promise((resolve, reject) => {
    const st = cloudinary.uploader.upload_stream({ folder: 'genesis/fotos_usuarios', resource_type: 'image',
      transformation: [{ width: 300, height: 300, crop: 'fill', gravity: 'face' }] }, (err, r) => (err ? reject(err) : resolve(r.secure_url)));
    st.end(req.file.buffer);
  });
  await pool.query('UPDATE users SET foto_url = $1 WHERE id = $2', [url, id]);
  await logActivity(req.user.id, 'sistema_foto_cambiada', { id }, req.ip);
  res.json({ foto: url });
}));
router.delete('/usuarios/:id/foto', guard(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id || !(await puedeCambiarFoto(req, id))) return res.status(403).json({ error: 'No puedes cambiar la foto de este usuario.' });
  await pool.query('UPDATE users SET foto_url = NULL WHERE id = $1', [id]);
  res.json({ message: 'Foto quitada.' });
}));

// ============================== Actividad de usuarios ==============================
// Quien entro, a que hora y que hizo. La asociacion ve a su gente; el asesor, a las asociaciones que
// atiende y al equipo; el fundador, a todos.
const { textoAccion } = require('../utils/actividadTexto');
router.get('/actividad', exigir('actividad'), guard(async (req, res) => {
  const hoy = todayCO();
  const desde = isValidYmd(req.query.desde) ? req.query.desde : hoy;
  const hasta = isValidYmd(req.query.hasta) ? req.query.hasta : hoy;
  if (desde > hasta) return res.status(400).json({ error: 'Rango de fechas inválido.' });
  const params = [desde, hasta];
  // Quienes puede ver
  let alcance;
  if (req.sis.esAdm) alcance = 'TRUE';
  else if (req.sis.todas) {
    params.push(req.sis.idsCentros);
    alcance = `(u.association_id IN (SELECT association_id FROM tz_centros WHERE id = ANY($${params.length}::int[])) OR (p.todas_asociaciones AND p.cod_perfil <> 'ADM' AND u.role <> 'pro'))`;
  } else {
    params.push(req.sis.usuario.association_id);
    alcance = `u.association_id = $${params.length} AND u.role <> 'pro'`;
  }
  if (parseId(req.query.user_id)) { params.push(parseId(req.query.user_id)); alcance += ` AND u.id = $${params.length}`; }
  const r = await pool.query(
    `SELECT l.id, to_char((l.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS') AS fecha_hora,
            l.action, l.details, u.id AS user_id, u.full_name, u.foto_url, p.desc_perfil
     FROM activity_logs l JOIN users u ON u.id = l.user_id LEFT JOIN gt_perfiles p ON p.id = u.id_perfil
     WHERE ((l.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Bogota')::date BETWEEN $1 AND $2 AND ${alcance}
     ORDER BY l.created_at DESC LIMIT 2000`, params);
  res.json(r.rows.map((x) => ({
    id: x.id, fecha_hora: x.fecha_hora, user_id: x.user_id, usuario: x.full_name, foto: x.foto_url, perfil: x.desc_perfil,
    accion: textoAccion(x.action, x.details)
  })));
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
