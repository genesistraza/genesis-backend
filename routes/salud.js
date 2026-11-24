// Salud (seguridad social) - sandbox para los prestadores (fundador y asesores Genesis).
// Primera version: registro de datos de las empresas (asociaciones) que se administran en seguridad
// social, sus recicladores (Decreto 271 de 2026), trabajadores, beneficiarios y novedades.
// Aislado del resto: tablas ss_*, no toca Registro ni Pruebas (solo LEE recicladores de Registro
// para traerlos con un boton).
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();
router.use(requireAuth, requireRole('pro', 'admin'));

const TIPOS_DOC = ['CC', 'CE', 'TI', 'RC', 'PA', 'PPT', 'NIT'];
const SI_NO = 'bool';

// Definicion de cada pantalla: campos, tipo y validacion. "ref" = select de otra tabla.
const ENT = {
  empresas: {
    tabla: 'ss_empresas', titulo: 'Empresas', orden: 'nombre',
    campos: [
      { n: 'nombre', l: 'Razón social', t: 'text', req: true, max: 200, sec: 'Datos de la empresa' },
      { n: 'nit', l: 'NIT', t: 'text', req: true, max: 20, re: /^[0-9]{5,15}$/, reMsg: 'solo números, sin DV' },
      { n: 'dv', l: 'DV', t: 'text', max: 1, re: /^[0-9]$/, reMsg: 'un dígito' },
      { n: 'association_id', l: 'Asociación en Genesis Traza', t: 'ref', ref: 'associations' },
      { n: 'direccion', l: 'Dirección', t: 'text', max: 200 },
      { n: 'municipio', l: 'Municipio', t: 'text', max: 100 },
      { n: 'departamento', l: 'Departamento', t: 'text', max: 100 },
      { n: 'telefono', l: 'Teléfono', t: 'text', max: 30 },
      { n: 'correo', l: 'Correo', t: 'text', max: 150, re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, reMsg: 'correo inválido' },
      { n: 'rep_legal_nombre', l: 'Representante legal', t: 'text', max: 150 },
      { n: 'rep_legal_doc', l: 'Cédula representante legal', t: 'text', max: 20, re: /^[0-9]{4,15}$/, reMsg: 'solo números' },
      { n: 'arl', l: 'ARL', t: 'text', max: 100, sec: 'Seguridad social' },
      { n: 'caja_compensacion', l: 'Caja de compensación', t: 'text', max: 100 },
      { n: 'operador_pila', l: 'Operador PILA', t: 'text', max: 100 },
      { n: 'estado', l: 'Estado', t: 'opt', opts: ['Prospecto', 'Vinculada', 'Suspendida', 'Retirada'], req: true },
      { n: 'fecha_vinculacion', l: 'Fecha de vinculación', t: 'date' },
      { n: 'doc_contrato', l: 'Contrato', t: SI_NO, sec: 'Afiliación de la empresa (documentos recibidos)' },
      { n: 'doc_confidencialidad', l: 'Acuerdo de confidencialidad', t: SI_NO },
      { n: 'doc_mandato', l: 'Mandato', t: SI_NO },
      { n: 'doc_camara', l: 'Cámara de comercio', t: SI_NO },
      { n: 'doc_rut', l: 'RUT', t: SI_NO },
      { n: 'doc_rups', l: 'RUPS', t: SI_NO },
      { n: 'doc_cedula_rl', l: 'Cédula del representante legal', t: SI_NO },
      { n: 'observaciones', l: 'Observaciones', t: 'textarea', max: 1000 }
    ]
  },
  recicladores: {
    tabla: 'ss_personas', titulo: 'Recicladores', fijo: { tipo: 'reciclador' }, orden: 'apellidos, nombres',
    campos: [
      { n: 'id_empresa', l: 'Empresa', t: 'ref', ref: 'empresas', req: true, sec: 'Identificación' },
      { n: 'tipo_doc', l: 'Tipo documento', t: 'opt', opts: TIPOS_DOC, req: true },
      { n: 'nro_doc', l: 'Número documento', t: 'text', req: true, max: 20, re: /^[0-9A-Za-z]{3,20}$/, reMsg: 'sin puntos ni espacios' },
      { n: 'nombres', l: 'Nombres', t: 'text', req: true, max: 100 },
      { n: 'apellidos', l: 'Apellidos', t: 'text', req: true, max: 100 },
      { n: 'fecha_nacimiento', l: 'Fecha de nacimiento', t: 'date' },
      { n: 'sexo', l: 'Sexo', t: 'opt', opts: ['F', 'M'] },
      { n: 'telefono', l: 'Celular / WhatsApp', t: 'text', max: 30 },
      { n: 'direccion', l: 'Dirección', t: 'text', max: 200 },
      { n: 'municipio', l: 'Municipio', t: 'text', max: 100 },
      { n: 'ingreso_mensual', l: 'Ingreso mensual (ref.)', t: 'num', sec: 'Seguridad social (Decreto 271 de 2026)' },
      { n: 'eps', l: 'EPS', t: 'text', max: 100 },
      { n: 'regimen_salud', l: 'Régimen de salud', t: 'opt', opts: ['Subsidiado', 'Contributivo', 'Sin afiliación'] },
      { n: 'arl_afiliado', l: 'Afiliado a ARL', t: SI_NO },
      { n: 'fecha_afiliacion_arl', l: 'Fecha afiliación ARL', t: 'date' },
      { n: 'beps_vinculado', l: 'Vinculado a BEPS', t: SI_NO },
      { n: 'estado', l: 'Estado', t: 'opt', opts: ['Activo', 'Retirado'], req: true },
      { n: 'fecha_retiro', l: 'Fecha de retiro', t: 'date' },
      { n: 'autoriza_datos', l: 'Autorizó tratamiento de datos', t: SI_NO },
      { n: 'observaciones', l: 'Observaciones', t: 'textarea', max: 1000 }
    ]
  },
  trabajadores: {
    tabla: 'ss_personas', titulo: 'Trabajadores', fijo: { tipo: 'trabajador' }, orden: 'apellidos, nombres',
    campos: [
      { n: 'id_empresa', l: 'Empresa', t: 'ref', ref: 'empresas', req: true, sec: 'Identificación' },
      { n: 'tipo_doc', l: 'Tipo documento', t: 'opt', opts: TIPOS_DOC, req: true },
      { n: 'nro_doc', l: 'Número documento', t: 'text', req: true, max: 20, re: /^[0-9A-Za-z]{3,20}$/, reMsg: 'sin puntos ni espacios' },
      { n: 'nombres', l: 'Nombres', t: 'text', req: true, max: 100 },
      { n: 'apellidos', l: 'Apellidos', t: 'text', req: true, max: 100 },
      { n: 'fecha_nacimiento', l: 'Fecha de nacimiento', t: 'date' },
      { n: 'sexo', l: 'Sexo', t: 'opt', opts: ['F', 'M'] },
      { n: 'telefono', l: 'Celular / WhatsApp', t: 'text', max: 30 },
      { n: 'correo', l: 'Correo', t: 'text', max: 150, re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, reMsg: 'correo inválido' },
      { n: 'direccion', l: 'Dirección', t: 'text', max: 200 },
      { n: 'municipio', l: 'Municipio', t: 'text', max: 100 },
      { n: 'cargo', l: 'Cargo', t: 'text', max: 100, sec: 'Contrato' },
      { n: 'tipo_contrato', l: 'Tipo de contrato', t: 'opt', opts: ['Término indefinido', 'Término fijo', 'Obra o labor', 'Aprendizaje', 'Prestación de servicios'] },
      { n: 'salario', l: 'Salario / honorarios', t: 'num' },
      { n: 'fecha_ingreso', l: 'Fecha de ingreso', t: 'date' },
      { n: 'eps', l: 'EPS', t: 'text', max: 100, sec: 'Seguridad social' },
      { n: 'afp', l: 'Fondo de pensiones', t: 'text', max: 100 },
      { n: 'caja_compensacion', l: 'Caja de compensación', t: 'text', max: 100 },
      { n: 'arl_afiliado', l: 'Afiliado a ARL', t: SI_NO },
      { n: 'fecha_afiliacion_arl', l: 'Fecha afiliación ARL', t: 'date' },
      { n: 'estado', l: 'Estado', t: 'opt', opts: ['Activo', 'Retirado'], req: true },
      { n: 'fecha_retiro', l: 'Fecha de retiro', t: 'date' },
      { n: 'autoriza_datos', l: 'Autorizó tratamiento de datos', t: SI_NO },
      { n: 'observaciones', l: 'Observaciones', t: 'textarea', max: 1000 }
    ]
  },
  beneficiarios: {
    tabla: 'ss_beneficiarios', titulo: 'Beneficiarios', orden: 'apellidos, nombres',
    campos: [
      { n: 'id_persona', l: 'Titular', t: 'ref', ref: 'personas', req: true },
      { n: 'parentesco', l: 'Parentesco', t: 'opt', opts: ['Cónyuge / compañero(a)', 'Hijo(a)', 'Padre / madre', 'Otro'], req: true },
      { n: 'tipo_doc', l: 'Tipo documento', t: 'opt', opts: TIPOS_DOC, req: true },
      { n: 'nro_doc', l: 'Número documento', t: 'text', req: true, max: 20, re: /^[0-9A-Za-z]{3,20}$/, reMsg: 'sin puntos ni espacios' },
      { n: 'nombres', l: 'Nombres', t: 'text', req: true, max: 100 },
      { n: 'apellidos', l: 'Apellidos', t: 'text', req: true, max: 100 },
      { n: 'fecha_nacimiento', l: 'Fecha de nacimiento', t: 'date' },
      { n: 'sexo', l: 'Sexo', t: 'opt', opts: ['F', 'M'] },
      { n: 'afiliado_eps', l: 'Afiliado a EPS', t: SI_NO },
      { n: 'afiliado_caja', l: 'Afiliado a caja', t: SI_NO },
      { n: 'observaciones', l: 'Observaciones', t: 'textarea', max: 1000 }
    ]
  },
  novedades: {
    tabla: 'ss_novedades', titulo: 'Novedades', orden: 'fecha_inicio DESC, id DESC',
    campos: [
      { n: 'id_persona', l: 'Persona', t: 'ref', ref: 'personas', req: true },
      { n: 'tipo', l: 'Novedad', t: 'opt', opts: ['Afiliación', 'Retiro / desafiliación', 'Incapacidad', 'Licencia', 'Accidente de trabajo', 'Variación de salario', 'Otra'], req: true },
      { n: 'entidad', l: 'Entidad', t: 'opt', opts: ['ARL', 'EPS', 'Pensión', 'Caja', 'BEPS'] },
      { n: 'fecha_inicio', l: 'Fecha', t: 'date', req: true },
      { n: 'fecha_fin', l: 'Hasta', t: 'date' },
      { n: 'dias', l: 'Días', t: 'int' },
      { n: 'formato', l: 'Formato', t: 'opt', opts: ['FURAT', 'FUREL', 'FURIPS', 'Otro'] },
      { n: 'radicado', l: 'Radicado', t: 'text', max: 60 },
      { n: 'estado', l: 'Estado', t: 'opt', opts: ['Pendiente', 'Radicada', 'Aprobada', 'Rechazada', 'Pagada', 'Cerrada'], req: true },
      { n: 'valor', l: 'Valor', t: 'num' },
      { n: 'observaciones', l: 'Observaciones', t: 'textarea', max: 1000 }
    ]
  }
};

const ymd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// Valida y limpia un cuerpo segun los campos de la pantalla. Devuelve { errores, valores }.
async function limpiar(ent, body, nuevo) {
  const errores = [], valores = {};
  for (const c of ent.campos) {
    if (!(c.n in body)) { if (nuevo && c.req) errores.push(`"${c.l}" es obligatorio.`); continue; }
    let v = body[c.n];
    if (v === '' || v === undefined) v = null;
    if (c.t === 'bool') { valores[c.n] = v === true || v === 'true' || v === 1 || v === '1'; continue; }
    if (v === null) { if (c.req) errores.push(`"${c.l}" es obligatorio.`); valores[c.n] = null; continue; }
    if (c.t === 'text' || c.t === 'textarea') {
      v = String(v).trim();
      if (!v && c.req) { errores.push(`"${c.l}" es obligatorio.`); continue; }
      if (c.max && v.length > c.max) { errores.push(`"${c.l}": máximo ${c.max} caracteres.`); continue; }
      if (v && c.re && !c.re.test(v)) { errores.push(`"${c.l}": ${c.reMsg}.`); continue; }
      valores[c.n] = v || null;
    } else if (c.t === 'date') {
      if (!ymd(String(v))) { errores.push(`"${c.l}": fecha inválida.`); continue; }
      valores[c.n] = String(v);
    } else if (c.t === 'num' || c.t === 'int') {
      const n = Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || (c.t === 'int' && !Number.isInteger(n))) { errores.push(`"${c.l}": número inválido.`); continue; }
      valores[c.n] = n;
    } else if (c.t === 'opt') {
      if (!c.opts.includes(String(v))) { errores.push(`"${c.l}": opción no válida.`); continue; }
      valores[c.n] = String(v);
    } else if (c.t === 'ref') {
      const id = parseId(v);
      const tabla = { associations: 'associations', empresas: 'ss_empresas', personas: 'ss_personas' }[c.ref];
      if (!id || !(await pool.query(`SELECT 1 FROM ${tabla} WHERE id = $1`, [id])).rows.length) { errores.push(`"${c.l}": no existe.`); continue; }
      valores[c.n] = id;
    }
  }
  return { errores, valores };
}

function chequeosCruzados(clave, v, previo) {
  const x = Object.assign({}, previo || {}, v), e = [];
  if (x.fecha_retiro && x.fecha_ingreso && x.fecha_retiro < x.fecha_ingreso) e.push('La fecha de retiro no puede ser anterior a la de ingreso.');
  if (x.fecha_fin && x.fecha_inicio && x.fecha_fin < x.fecha_inicio) e.push('"Hasta" no puede ser anterior a la fecha de la novedad.');
  if ((clave === 'recicladores' || clave === 'trabajadores') && x.estado === 'Retirado' && !x.fecha_retiro) e.push('Escribe la fecha de retiro.');
  return e;
}

const entidad = (req, res) => {
  const e = ENT[req.params.ent];
  if (!e) { res.status(404).json({ error: 'Pantalla no encontrada.' }); return null; }
  return e;
};
const errorBd = (err, res) => {
  if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un registro con ese documento en esa empresa.' });
  if (err.code === '23503' || err.code === '23001') return res.status(409).json({ error: 'No se puede borrar: tiene registros que dependen de él (personas, beneficiarios o novedades).' });
  throw err;
};

// GET /salud/meta -> campos de cada pantalla (para armar tablas y formularios)
router.get('/meta', (req, res) => {
  const out = {};
  for (const k in ENT) out[k] = { titulo: ENT[k].titulo, campos: ENT[k].campos.map((c) => ({ n: c.n, l: c.l, t: c.t, req: !!c.req, opts: c.opts, ref: c.ref, sec: c.sec })) };
  res.json(out);
});

// GET /salud/opciones/:ref -> opciones de los selects de referencia
router.get('/opciones/:ref', asyncRoute(async (req, res) => {
  const q = {
    associations: "SELECT id AS value, name || COALESCE(' (NIT ' || nit || ')', '') AS label FROM associations ORDER BY name",
    empresas: 'SELECT id AS value, nombre AS label FROM ss_empresas ORDER BY nombre',
    personas: `SELECT p.id AS value, p.apellidos || ' ' || p.nombres || ' — ' || p.tipo_doc || ' ' || p.nro_doc || ' (' || initcap(p.tipo) || ', ' || e.nombre || ')' AS label
               FROM ss_personas p JOIN ss_empresas e ON e.id = p.id_empresa ORDER BY p.apellidos, p.nombres`
  }[req.params.ref];
  if (!q) return res.status(404).json({ error: 'Lista no encontrada.' });
  res.json((await pool.query(q)).rows);
}));

// GET /salud/resumen -> conteos por empresa para el inicio
router.get('/resumen', asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT e.id, e.nombre, e.nit, e.estado,
            (SELECT count(*)::int FROM ss_personas p WHERE p.id_empresa = e.id AND p.tipo = 'reciclador' AND p.estado = 'Activo') AS recicladores,
            (SELECT count(*)::int FROM ss_personas p WHERE p.id_empresa = e.id AND p.tipo = 'reciclador' AND p.estado = 'Activo' AND p.arl_afiliado) AS con_arl,
            (SELECT count(*)::int FROM ss_personas p WHERE p.id_empresa = e.id AND p.tipo = 'trabajador' AND p.estado = 'Activo') AS trabajadores,
            (SELECT count(*)::int FROM ss_novedades n JOIN ss_personas p ON p.id = n.id_persona WHERE p.id_empresa = e.id AND n.estado IN ('Pendiente', 'Radicada')) AS novedades_abiertas,
            (CASE WHEN e.doc_contrato THEN 1 ELSE 0 END + CASE WHEN e.doc_confidencialidad THEN 1 ELSE 0 END + CASE WHEN e.doc_mandato THEN 1 ELSE 0 END +
             CASE WHEN e.doc_camara THEN 1 ELSE 0 END + CASE WHEN e.doc_rut THEN 1 ELSE 0 END + CASE WHEN e.doc_rups THEN 1 ELSE 0 END + CASE WHEN e.doc_cedula_rl THEN 1 ELSE 0 END) AS documentos
     FROM ss_empresas e ORDER BY e.nombre`);
  res.json(r.rows);
}));

// GET /salud/datos/:ent[?id_empresa=] -> filas con etiquetas
router.get('/datos/:ent', asyncRoute(async (req, res) => {
  const e = entidad(req, res); if (!e) return;
  const cond = [], params = [];
  if (e.fijo) { params.push(e.fijo.tipo); cond.push('t.tipo = $' + params.length); }
  const emp = parseId(req.query.id_empresa);
  let sql;
  if (e.tabla === 'ss_empresas') {
    if (emp) { params.push(emp); cond.push('t.id = $' + params.length); }
    sql = `SELECT t.*, a.name AS association_id_label FROM ss_empresas t LEFT JOIN associations a ON a.id = t.association_id`;
  } else if (e.tabla === 'ss_personas') {
    if (emp) { params.push(emp); cond.push('t.id_empresa = $' + params.length); }
    sql = `SELECT t.*, e.nombre AS id_empresa_label FROM ss_personas t JOIN ss_empresas e ON e.id = t.id_empresa`;
  } else {
    if (emp) { params.push(emp); cond.push('p.id_empresa = $' + params.length); }
    sql = `SELECT t.*, p.apellidos || ' ' || p.nombres || ' (' || p.nro_doc || ')' AS id_persona_label, e.nombre AS empresa
           FROM ${e.tabla} t JOIN ss_personas p ON p.id = t.id_persona JOIN ss_empresas e ON e.id = p.id_empresa`;
  }
  const r = await pool.query(`${sql} ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY ${e.orden.split(',').map((x) => 't.' + x.trim()).join(', ')} LIMIT 5000`, params);
  res.json(r.rows);
}));

router.post('/datos/:ent', asyncRoute(async (req, res) => {
  const e = entidad(req, res); if (!e) return;
  const { errores, valores } = await limpiar(e, req.body || {}, true);
  errores.push(...chequeosCruzados(req.params.ent, valores));
  if (errores.length) return res.status(400).json({ error: errores.slice(0, 3).join(' '), detalles: errores });
  const datos = Object.assign({}, valores, e.fijo || {}, { created_by: req.user.id });
  const cols = Object.keys(datos);
  try {
    const r = await pool.query(`INSERT INTO ${e.tabla} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, cols.map((c) => datos[c]));
    await logActivity(req.user.id, 'salud_creado', { pantalla: req.params.ent, id: r.rows[0].id }, req.ip);
    res.json({ id: r.rows[0].id });
  } catch (err) { errorBd(err, res); }
}));

router.put('/datos/:ent/:id', asyncRoute(async (req, res) => {
  const e = entidad(req, res); if (!e) return;
  const id = parseId(req.params.id);
  const previo = id && (await pool.query(`SELECT * FROM ${e.tabla} WHERE id = $1${e.fijo ? ' AND tipo = $2' : ''}`, e.fijo ? [id, e.fijo.tipo] : [id])).rows[0];
  if (!previo) return res.status(404).json({ error: 'Registro no encontrado.' });
  const { errores, valores } = await limpiar(e, req.body || {}, false);
  errores.push(...chequeosCruzados(req.params.ent, valores, previo));
  if (errores.length) return res.status(400).json({ error: errores.slice(0, 3).join(' '), detalles: errores });
  const cols = Object.keys(valores);
  if (!cols.length) return res.status(400).json({ error: 'Nada para actualizar.' });
  try {
    await pool.query(`UPDATE ${e.tabla} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW() WHERE id = $${cols.length + 1}`, [...cols.map((c) => valores[c]), id]);
    await logActivity(req.user.id, 'salud_editado', { pantalla: req.params.ent, id }, req.ip);
    res.json({ id });
  } catch (err) { errorBd(err, res); }
}));

router.delete('/datos/:ent/:id', asyncRoute(async (req, res) => {
  const e = entidad(req, res); if (!e) return;
  const id = parseId(req.params.id);
  try {
    const r = await pool.query(`DELETE FROM ${e.tabla} WHERE id = $1${e.fijo ? ' AND tipo = $2' : ''}`, e.fijo ? [id, e.fijo.tipo] : [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Registro no encontrado.' });
    await logActivity(req.user.id, 'salud_eliminado', { pantalla: req.params.ent, id }, req.ip);
    res.json({ ok: true });
  } catch (err) { errorBd(err, res); }
}));

// POST /salud/empresas/:id/traer-recicladores -> copia los recicladores que la asociacion ya tiene en
// Registro (los que falten, por documento). Estado Activo; lo de seguridad social queda por llenar.
router.post('/empresas/:id/traer-recicladores', asyncRoute(async (req, res) => {
  const emp = (await pool.query('SELECT id, association_id FROM ss_empresas WHERE id = $1', [parseId(req.params.id)])).rows[0];
  if (!emp) return res.status(404).json({ error: 'Empresa no encontrada.' });
  if (!emp.association_id) return res.status(400).json({ error: 'Primero enlaza la empresa con su asociación de Genesis Traza.' });
  const r = await pool.query(
    `INSERT INTO ss_personas (id_empresa, tipo, tipo_doc, nro_doc, nombres, apellidos, fecha_nacimiento, telefono, direccion, estado, created_by)
     SELECT $1, 'reciclador', 'CC', regexp_replace(r.nro_documento, '[^0-9A-Za-z]', '', 'g'),
            COALESCE(NULLIF(split_part(trim(r.nombre_completo), ' ', 1), ''), '-'),
            COALESCE(NULLIF(trim(substr(trim(r.nombre_completo), length(split_part(trim(r.nombre_completo), ' ', 1)) + 1)), ''), '-'),
            r.fecha_nacimiento, r.telefono, r.direccion, 'Activo', $3
     FROM tz_recicladores r JOIN tz_centros c ON c.id = r.id_centro AND c.modulo = 'sistema' AND c.association_id = $2
     WHERE COALESCE(r.nro_documento, '') <> ''
     ON CONFLICT (id_empresa, tipo, tipo_doc, nro_doc) DO NOTHING`, [emp.id, emp.association_id, req.user.id]);
  await logActivity(req.user.id, 'salud_recicladores_traidos', { id: emp.id, filas: r.rowCount }, req.ip);
  res.json({ agregados: r.rowCount });
}));

module.exports = router;
