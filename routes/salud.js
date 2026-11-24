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
      { n: 'codigo_arl', l: 'Código ARL (PILA, 6 caract.)', t: 'text', max: 6, re: /^[0-9A-Za-z-]{2,6}$/, reMsg: 'código de la ARL en la PILA, p. ej. 14-23' },
      { n: 'centro_trabajo', l: 'Centro de trabajo ARL', t: 'text', max: 9, re: /^[0-9]{1,9}$/, reMsg: 'solo números' },
      { n: 'cod_dane_municipio', l: 'Código DANE municipio', t: 'text', max: 5, re: /^[0-9]{5}$/, reMsg: '5 dígitos, p. ej. 11001 Bogotá' },
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
      { n: 'cod_dane_municipio', l: 'Código DANE municipio (si es otro)', t: 'text', max: 5, re: /^[0-9]{5}$/, reMsg: '5 dígitos' },
      { n: 'ingreso_mensual', l: 'Ingreso mensual (si no está en Registro)', t: 'num', sec: 'Seguridad social (Decreto 271 de 2026)' },
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
  // Novedades: los dias se calculan solos (dias calendario contando el primero y el ultimo).
  if (clave === 'novedades' && ('fecha_inicio' in v || 'fecha_fin' in v || 'dias' in v)) {
    v.dias = x.fecha_inicio && x.fecha_fin && x.fecha_fin >= x.fecha_inicio
      ? Math.round((Date.parse(x.fecha_fin + 'T00:00:00Z') - Date.parse(x.fecha_inicio + 'T00:00:00Z')) / 86400000) + 1 : null;
  }
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

// ============================ Fase 1: liquidacion mensual ============================
// Recicladores de oficio (Decreto 271 de 2026, Resolucion 1529 de 2026): ARL que paga la organizacion
// sobre 1 SMLMV, clase de riesgo 5, periodos mensuales completos (las novedades son informativas salvo
// IRL, cuyos dias no cotizan a ARL); BEPS = 5 % del ingreso mensual real del reciclador (lo que le
// pagaron por material en Registro), que se paga aparte a Colpensiones como tercero aportante.
const { archivoPila, ibcRedondeo, aporteRedondeo } = require('../utils/pilaArchivo');
const DOCS_PILA = ['CC', 'CE', 'TI', 'PA', 'CD', 'SC', 'RC', 'PE'];
const periodoValido = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));
const finDeMes = (p) => { const [y, m] = p.split('-').map(Number); return p + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0'); };
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
const hoyCO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

async function calcularLiquidacion(idEmpresa, periodo) {
  const emp = (await pool.query('SELECT * FROM ss_empresas WHERE id = $1', [idEmpresa])).rows[0];
  if (!emp) return { error: 'Empresa no encontrada.' };
  const par = (await pool.query('SELECT * FROM ss_parametros WHERE anio = $1', [Number(periodo.slice(0, 4))])).rows[0];
  if (!par) return { error: 'Falta el salario mínimo de ' + periodo.slice(0, 4) + ' en Parámetros.' };
  const ini = periodo + '-01', fin = finDeMes(periodo);
  const smlmv = Number(par.smlmv), tarifa = Number(par.tarifa_arl_clase5), tBeps = Number(par.tarifa_beps);

  const errores = [];
  if (!emp.codigo_arl) errores.push('La empresa no tiene el código de la ARL para la PILA.');
  if (!emp.centro_trabajo) errores.push('La empresa no tiene el centro de trabajo de la ARL.');
  if (!emp.dv) errores.push('La empresa no tiene el dígito de verificación (DV) del NIT.');

  const personas = (await pool.query(
    `SELECT * FROM ss_personas WHERE id_empresa = $1 AND tipo = 'reciclador' AND arl_afiliado
       AND (fecha_afiliacion_arl IS NULL OR fecha_afiliacion_arl <= $3)
       AND NOT (estado = 'Retirado' AND fecha_retiro IS NOT NULL AND fecha_retiro < $2)
     ORDER BY apellidos, nombres`, [idEmpresa, ini, fin])).rows;

  // Lo que le pagaron a cada reciclador por material en Registro (por cedula) y los dias con registro.
  const ingresos = {}, enRegistro = new Set();
  if (emp.association_id) {
    (await pool.query(
      `SELECT regexp_replace(r.nro_documento, '[^0-9A-Za-z]', '', 'g') AS doc,
              COALESCE(SUM(bm.cantidad * bm.valor), 0)::float AS ingreso, COUNT(DISTINCT bm.fecha)::int AS dias
       FROM tz_formulario_balance_masas bm
       JOIN tz_recicladores r ON r.id = bm.id_reciclador
       JOIN tz_centros c ON c.id = bm.id_centro AND c.modulo = 'sistema' AND c.association_id = $1
       WHERE bm.fecha BETWEEN $2 AND $3 GROUP BY 1`, [emp.association_id, ini, fin])).rows
      .forEach((x) => { ingresos[x.doc] = x; });
    (await pool.query(
      `SELECT DISTINCT regexp_replace(r.nro_documento, '[^0-9A-Za-z]', '', 'g') AS doc FROM tz_recicladores r
       JOIN tz_centros c ON c.id = r.id_centro AND c.modulo = 'sistema' AND c.association_id = $1`, [emp.association_id])).rows
      .forEach((x) => enRegistro.add(x.doc));
  }
  // Incapacidades laborales (IRL) del periodo: dias que no cotizan a ARL.
  const irl = {};
  (await pool.query(
    `SELECT n.id_persona, n.fecha_inicio, COALESCE(n.fecha_fin, n.fecha_inicio) AS fecha_fin FROM ss_novedades n
     JOIN ss_personas p ON p.id = n.id_persona
     WHERE p.id_empresa = $1 AND n.entidad = 'ARL' AND n.tipo IN ('Incapacidad', 'Accidente de trabajo')
       AND n.fecha_inicio <= $3 AND COALESCE(n.fecha_fin, n.fecha_inicio) >= $2 AND n.estado <> 'Rechazada'`, [idEmpresa, ini, fin])).rows
    .forEach((n) => {
      const a = n.fecha_inicio > ini ? n.fecha_inicio : ini, b = n.fecha_fin < fin ? n.fecha_fin : fin;
      const x = irl[n.id_persona] || (irl[n.id_persona] = { dias: 0, ini: a, fin: b });
      x.dias += diasEntre(a, b); if (a < x.ini) x.ini = a; if (b > x.fin) x.fin = b;
    });

  const filas = personas.map((p) => {
    const al = [];
    const doc = String(p.nro_doc || '');
    if (!DOCS_PILA.includes(p.tipo_doc)) al.push('!Tipo de documento ' + p.tipo_doc + ' no es válido en la PILA.');
    if (['CC', 'TI', 'CE', 'RC', 'SC'].includes(p.tipo_doc) && !/^[0-9]+$/.test(doc)) al.push('!El documento debe ser solo números.');
    if (!p.apellidos || p.apellidos === '-' || !p.nombres || p.nombres === '-') al.push('!Falta nombre o apellido.');
    if (!(p.cod_dane_municipio || emp.cod_dane_municipio)) al.push('!Falta el código DANE del municipio.');
    if (!p.fecha_afiliacion_arl) al.push('!Falta la fecha de afiliación a la ARL.');
    const reg = ingresos[doc.replace(/[^0-9A-Za-z]/g, '')];
    let ingreso = 0, fuente = 'Sin dato';
    if (reg) { ingreso = reg.ingreso; fuente = 'Registro'; } else if (p.ingreso_mensual != null) { ingreso = Number(p.ingreso_mensual); fuente = 'Manual'; }
    if (emp.association_id && !reg && !(p.estado === 'Retirado')) al.push('Sin material registrado en el mes: ¿hay que reportar el retiro?');
    if (emp.association_id && !enRegistro.has(doc.replace(/[^0-9A-Za-z]/g, ''))) al.push('No está en Registro de la asociación (puede no estar en el reporte de la Superservicios).');
    if (ingreso >= smlmv) al.push('Ganó 1 salario mínimo o más: verificar si le aplica el Decreto 271.');
    if (!p.autoriza_datos) al.push('No ha firmado la autorización de datos.');
    if (fuente === 'Sin dato') al.push('Sin ingreso del mes: el BEPS queda en 0.');
    const ir = irl[p.id];
    const diasIrl = ir ? Math.min(30, ir.dias) : 0;
    const diasArl = Math.max(0, 30 - diasIrl);
    const ibc = diasArl ? ibcRedondeo(smlmv * diasArl / 30) : 0;
    const aporte = diasArl ? aporteRedondeo(ibc * tarifa / 100) : 0;
    const novIng = !!(p.fecha_afiliacion_arl && p.fecha_afiliacion_arl >= ini && p.fecha_afiliacion_arl <= fin);
    const novRet = !!(p.estado === 'Retirado' && p.fecha_retiro && p.fecha_retiro >= ini && p.fecha_retiro <= fin);
    return {
      id_persona: p.id, tipo_doc: p.tipo_doc, nro_doc: doc, nombres: p.nombres, apellidos: p.apellidos,
      cod_dane_municipio: p.cod_dane_municipio || emp.cod_dane_municipio || null,
      ingreso_mes: Math.round(ingreso * 100) / 100, fuente_ingreso: fuente, dias_registro: reg ? reg.dias : 0,
      dias_arl: diasArl, dias_irl: diasIrl, fecha_inicio_irl: ir ? ir.ini : null, fecha_fin_irl: ir ? ir.fin : null,
      ibc_arl: ibc, aporte_arl: aporte, beps: ingreso > 0 ? Math.ceil(ingreso * tBeps / 100 - 1e-9) : 0,
      nov_ingreso: novIng, fecha_ingreso: novIng ? p.fecha_afiliacion_arl : null,
      nov_retiro: novRet, fecha_retiro: novRet ? p.fecha_retiro : null,
      alertas: al
    };
  });
  if (!filas.length) errores.push('No hay recicladores afiliados a ARL para ese periodo (revisa "Afiliado a ARL" y su fecha).');
  const bloqueantes = filas.filter((f) => f.alertas.some((a) => a[0] === '!')).length;
  if (bloqueantes) errores.push(bloqueantes + ' reciclador(es) tienen datos que la PILA rechazaría (marcados en rojo).');
  return {
    empresa: { id: emp.id, nombre: emp.nombre, nit: emp.nit, dv: emp.dv }, periodo, smlmv, tarifa_arl: tarifa, tarifa_beps: tBeps,
    filas, errores,
    totales: { cotizantes: filas.length, arl: filas.reduce((s, f) => s + f.aporte_arl, 0), beps: filas.reduce((s, f) => s + f.beps, 0) }
  };
}

// GET/PUT /salud/parametros -> salario minimo y tarifas por año
router.get('/parametros', asyncRoute(async (req, res) => {
  res.json((await pool.query('SELECT anio, smlmv::float, tarifa_arl_clase5::float, tarifa_beps::float FROM ss_parametros ORDER BY anio DESC')).rows);
}));
router.put('/parametros/:anio', requireRole('pro'), asyncRoute(async (req, res) => {
  const anio = Number(req.params.anio), smlmv = Number(req.body.smlmv), t = Number(req.body.tarifa_arl_clase5), b = Number(req.body.tarifa_beps);
  if (!(anio >= 2020 && anio <= 2100) || !(smlmv > 0) || !(t > 0 && t < 100) || !(b >= 0 && b < 100)) return res.status(400).json({ error: 'Revisa el año, el salario mínimo y las tarifas.' });
  await pool.query(
    `INSERT INTO ss_parametros (anio, smlmv, tarifa_arl_clase5, tarifa_beps) VALUES ($1,$2,$3,$4)
     ON CONFLICT (anio) DO UPDATE SET smlmv = $2, tarifa_arl_clase5 = $3, tarifa_beps = $4, updated_at = NOW()`, [anio, smlmv, t, b]);
  await logActivity(req.user.id, 'salud_parametros', { anio, smlmv }, req.ip);
  res.json({ ok: true });
}));

// POST /salud/liquidacion/calcular {id_empresa, periodo} -> vista previa (no guarda)
router.post('/liquidacion/calcular', asyncRoute(async (req, res) => {
  const { id_empresa, periodo } = req.body || {};
  if (!parseId(id_empresa) || !periodoValido(periodo)) return res.status(400).json({ error: 'Elige la empresa y el periodo (mes).' });
  if (periodo > hoyCO().slice(0, 7)) return res.status(400).json({ error: 'No se puede liquidar un mes futuro.' });
  const previa = (await pool.query('SELECT id, estado FROM ss_liquidaciones WHERE id_empresa = $1 AND periodo = $2', [parseId(id_empresa), periodo])).rows[0];
  // Mes cerrado o pagado: se muestra lo que quedo guardado (congelado), no un calculo nuevo.
  if (previa && previa.estado !== 'Borrador') {
    const l = await liquidacionCompleta(previa.id);
    const emp = (await pool.query('SELECT id, nombre, nit, dv FROM ss_empresas WHERE id = $1', [l.id_empresa])).rows[0];
    const num = (v) => Number(v || 0);
    return res.json({
      empresa: emp, periodo, smlmv: num(l.smlmv), tarifa_arl: num(l.tarifa_arl), tarifa_beps: num(l.tarifa_beps), errores: [], guardada: previa,
      totales: { cotizantes: l.cotizantes, arl: num(l.total_arl), beps: num(l.total_beps) },
      filas: l.detalle.map((d) => Object.assign({}, d, { ingreso_mes: num(d.ingreso_mes), ibc_arl: num(d.ibc_arl), aporte_arl: num(d.aporte_arl), beps: num(d.beps) }))
    });
  }
  const r = await calcularLiquidacion(parseId(id_empresa), periodo);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(Object.assign(r, { guardada: previa || null }));
}));

// POST /salud/liquidaciones {id_empresa, periodo} -> guarda (o reemplaza) el borrador del mes
router.post('/liquidaciones', asyncRoute(async (req, res) => {
  const { id_empresa, periodo } = req.body || {};
  if (!parseId(id_empresa) || !periodoValido(periodo)) return res.status(400).json({ error: 'Elige la empresa y el periodo (mes).' });
  const previa = (await pool.query('SELECT id, estado FROM ss_liquidaciones WHERE id_empresa = $1 AND periodo = $2', [parseId(id_empresa), periodo])).rows[0];
  if (previa && previa.estado !== 'Borrador') return res.status(409).json({ error: 'Ese mes ya está ' + previa.estado.toLowerCase() + '; no se puede recalcular.' });
  const r = await calcularLiquidacion(parseId(id_empresa), periodo);
  if (r.error) return res.status(400).json({ error: r.error });
  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    if (previa) {
      id = previa.id;
      await client.query(`UPDATE ss_liquidaciones SET smlmv=$1, tarifa_arl=$2, tarifa_beps=$3, cotizantes=$4, total_arl=$5, total_beps=$6, updated_at=NOW() WHERE id=$7`,
        [r.smlmv, r.tarifa_arl, r.tarifa_beps, r.totales.cotizantes, r.totales.arl, r.totales.beps, id]);
      await client.query('DELETE FROM ss_liquidacion_detalle WHERE id_liquidacion = $1', [id]);
    } else {
      id = (await client.query(`INSERT INTO ss_liquidaciones (id_empresa, periodo, smlmv, tarifa_arl, tarifa_beps, cotizantes, total_arl, total_beps, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [r.empresa.id, periodo, r.smlmv, r.tarifa_arl, r.tarifa_beps, r.totales.cotizantes, r.totales.arl, r.totales.beps, req.user.id])).rows[0].id;
    }
    for (const f of r.filas) {
      await client.query(
        `INSERT INTO ss_liquidacion_detalle (id_liquidacion, id_persona, tipo_doc, nro_doc, nombres, apellidos, cod_dane_municipio, ingreso_mes, fuente_ingreso,
           dias_registro, dias_arl, dias_irl, fecha_inicio_irl, fecha_fin_irl, ibc_arl, aporte_arl, beps, nov_ingreso, fecha_ingreso, nov_retiro, fecha_retiro, alertas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [id, f.id_persona, f.tipo_doc, f.nro_doc, f.nombres, f.apellidos, f.cod_dane_municipio, f.ingreso_mes, f.fuente_ingreso, f.dias_registro, f.dias_arl, f.dias_irl,
          f.fecha_inicio_irl, f.fecha_fin_irl, f.ibc_arl, f.aporte_arl, f.beps, f.nov_ingreso, f.fecha_ingreso, f.nov_retiro, f.fecha_retiro, f.alertas.join('\n') || null]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await logActivity(req.user.id, 'salud_liquidacion_guardada', { id, periodo, cotizantes: r.totales.cotizantes }, req.ip);
  res.json({ id, errores: r.errores });
}));

// GET /salud/liquidaciones[?id_empresa] -> historial (control de pagos)
router.get('/liquidaciones', asyncRoute(async (req, res) => {
  const emp = parseId(req.query.id_empresa);
  const r = await pool.query(
    `SELECT l.id, l.id_empresa, e.nombre AS empresa, l.periodo, l.estado, l.cotizantes, l.total_arl::float, l.total_beps::float,
            l.numero_planilla, l.operador_pago, l.fecha_pago, l.valor_pagado::float,
            to_char(l.cerrada_en AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') AS cerrada_en
     FROM ss_liquidaciones l JOIN ss_empresas e ON e.id = l.id_empresa ${emp ? 'WHERE l.id_empresa = $1' : ''}
     ORDER BY l.periodo DESC, e.nombre`, emp ? [emp] : []);
  res.json(r.rows);
}));

async function liquidacionCompleta(id) {
  const l = (await pool.query('SELECT l.*, e.nombre AS empresa FROM ss_liquidaciones l JOIN ss_empresas e ON e.id = l.id_empresa WHERE l.id = $1', [id])).rows[0];
  if (!l) return null;
  l.detalle = (await pool.query('SELECT * FROM ss_liquidacion_detalle WHERE id_liquidacion = $1 ORDER BY apellidos, nombres', [id])).rows;
  l.detalle.forEach((d) => { d.alertas = d.alertas ? d.alertas.split('\n') : []; });
  return l;
}
router.get('/liquidaciones/:id', asyncRoute(async (req, res) => {
  const l = await liquidacionCompleta(parseId(req.params.id));
  if (!l) return res.status(404).json({ error: 'Liquidación no encontrada.' });
  res.json(l);
}));

// POST /salud/liquidaciones/:id/cerrar -> congela el mes (solo si no hay errores que la PILA rechazaria)
router.post('/liquidaciones/:id/cerrar', asyncRoute(async (req, res) => {
  const l = await liquidacionCompleta(parseId(req.params.id));
  if (!l) return res.status(404).json({ error: 'Liquidación no encontrada.' });
  if (l.estado !== 'Borrador') return res.status(409).json({ error: 'La liquidación ya está ' + l.estado.toLowerCase() + '.' });
  const emp = (await pool.query('SELECT * FROM ss_empresas WHERE id = $1', [l.id_empresa])).rows[0];
  const malos = l.detalle.filter((d) => d.alertas.some((a) => a[0] === '!')).length;
  if (!emp.codigo_arl || !emp.centro_trabajo || !emp.dv) return res.status(400).json({ error: 'Completa en la empresa el código ARL, el centro de trabajo y el DV antes de cerrar.' });
  if (malos) return res.status(400).json({ error: malos + ' reciclador(es) tienen datos que la PILA rechazaría. Corrígelos, vuelve a calcular y guarda.' });
  if (!l.detalle.length) return res.status(400).json({ error: 'La liquidación no tiene recicladores.' });
  await pool.query(`UPDATE ss_liquidaciones SET estado = 'Cerrada', cerrada_en = NOW(), cerrada_por = $1 WHERE id = $2`, [req.user.id, l.id]);
  await logActivity(req.user.id, 'salud_liquidacion_cerrada', { id: l.id, periodo: l.periodo }, req.ip);
  res.json({ ok: true });
}));

// POST /salud/liquidaciones/:id/reabrir -> vuelve a borrador (solo el fundador y si no esta pagada)
router.post('/liquidaciones/:id/reabrir', requireRole('pro'), asyncRoute(async (req, res) => {
  const r = await pool.query(`UPDATE ss_liquidaciones SET estado = 'Borrador', cerrada_en = NULL, cerrada_por = NULL WHERE id = $1 AND estado = 'Cerrada' RETURNING id`, [parseId(req.params.id)]);
  if (!r.rowCount) return res.status(409).json({ error: 'Solo se puede reabrir una liquidación cerrada y no pagada.' });
  await logActivity(req.user.id, 'salud_liquidacion_reabierta', { id: parseId(req.params.id) }, req.ip);
  res.json({ ok: true });
}));

// POST /salud/liquidaciones/:id/pago {numero_planilla, operador_pago, fecha_pago, valor_pagado}
router.post('/liquidaciones/:id/pago', asyncRoute(async (req, res) => {
  const { numero_planilla, operador_pago, fecha_pago, valor_pagado } = req.body || {};
  if (!/^[0-9]{1,20}$/.test(String(numero_planilla || ''))) return res.status(400).json({ error: 'Escribe el número de la planilla que dio el operador (solo números).' });
  if (!ymd(String(fecha_pago || '')) || fecha_pago > hoyCO()) return res.status(400).json({ error: 'Fecha de pago inválida.' });
  const v = Number(valor_pagado);
  if (!(v > 0)) return res.status(400).json({ error: 'Escribe el valor pagado.' });
  const r = await pool.query(
    `UPDATE ss_liquidaciones SET estado = 'Pagada', numero_planilla = $1, operador_pago = $2, fecha_pago = $3, valor_pagado = $4, pago_registrado_por = $5, updated_at = NOW()
     WHERE id = $6 AND estado = 'Cerrada' RETURNING id`, [String(numero_planilla), String(operador_pago || '').slice(0, 100) || null, fecha_pago, v, req.user.id, parseId(req.params.id)]);
  if (!r.rowCount) return res.status(409).json({ error: 'Primero cierra la liquidación (y no puede estar ya pagada).' });
  await logActivity(req.user.id, 'salud_liquidacion_pagada', { id: parseId(req.params.id), numero_planilla }, req.ip);
  res.json({ ok: true });
}));

// GET /salud/liquidaciones/:id/pila -> archivo plano para subir al operador (solo cerrada o pagada)
router.get('/liquidaciones/:id/pila', asyncRoute(async (req, res) => {
  const l = await liquidacionCompleta(parseId(req.params.id));
  if (!l) return res.status(404).json({ error: 'Liquidación no encontrada.' });
  if (l.estado === 'Borrador') return res.status(409).json({ error: 'Cierra la liquidación antes de descargar el archivo PILA.' });
  const emp = (await pool.query('SELECT * FROM ss_empresas WHERE id = $1', [l.id_empresa])).rows[0];
  let txt;
  try { txt = archivoPila(emp, l, l.detalle.filter((d) => d.dias_arl > 0 || d.nov_retiro || d.dias_irl > 0)); } catch (e) { return res.status(400).json({ error: 'No se pudo armar el archivo: ' + e.message }); }
  await logActivity(req.user.id, 'salud_pila_descargada', { id: l.id, periodo: l.periodo }, req.ip);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Content-Disposition', `attachment; filename="PILA_${emp.nit}_${l.periodo}_Y.txt"`);
  res.send(txt);
}));

// GET /salud/liquidaciones/:id/beps -> CSV de aportes BEPS (para Colpensiones)
router.get('/liquidaciones/:id/beps', asyncRoute(async (req, res) => {
  const l = await liquidacionCompleta(parseId(req.params.id));
  if (!l) return res.status(404).json({ error: 'Liquidación no encontrada.' });
  const filas = [['Tipo documento', 'Número documento', 'Apellidos', 'Nombres', 'Periodo', 'Ingreso del mes', 'Fuente del ingreso', 'Aporte BEPS (' + Number(l.tarifa_beps) + ' %)']]
    .concat(l.detalle.filter((d) => Number(d.beps) > 0).map((d) => [d.tipo_doc, d.nro_doc, d.apellidos, d.nombres, l.periodo, Math.round(Number(d.ingreso_mes)), d.fuente_ingreso, Math.round(Number(d.beps))]));
  const c = (v) => { v = String(v == null ? '' : v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Content-Disposition', `attachment; filename="BEPS_${l.periodo}_${l.id_empresa}.csv"`);
  res.send('﻿' + filas.map((f) => f.map(c).join(';')).join('\r\n'));
}));

module.exports = router;
