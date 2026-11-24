// Formulario publico de Salud: cada empresa recibe un link unico (token) y por ahi envia sus datos,
// documentos, recicladores, trabajadores y beneficiarios SIN iniciar sesion. Nada se escribe directo en
// las tablas de Salud: queda como "respuesta pendiente" (ss_solicitudes) y un prestador la revisa y la
// aplica. El link solo muestra el nombre y NIT de la empresa (no expone datos personales ya guardados).
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const cloudinary = require('../db/cloudinary');
const { asyncRoute } = require('../middleware/logger');
const salud = require('./salud');

const router = express.Router();
const MAX_PERSONAS = 3000;
const DOCS = { contrato: 'Contrato', confidencialidad: 'Acuerdo de confidencialidad', mandato: 'Mandato', camara: 'Cámara de comercio', rut: 'RUT', rups: 'RUPS', cedula_rl: 'Cédula del representante legal' };
const EXT_OK = /\.(pdf|png|jpe?g)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: Object.keys(DOCS).length, fieldSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, Object.prototype.hasOwnProperty.call(DOCS, file.fieldname) && EXT_OK.test(file.originalname || ''))
});
// Evita abuso del link: maximo 15 envios por hora por IP.
const limitarEnvios = rateLimit({ windowMs: 60 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados envíos seguidos. Intenta de nuevo en una hora.' } });

// Campos que la empresa puede llenar (sin referencias internas, estado, ni casillas de documentos).
const NO_PUBLICOS = new Set(['association_id', 'estado', 'fecha_vinculacion', 'fecha_retiro', 'arl_afiliado', 'fecha_afiliacion_arl', 'beps_vinculado',
  'codigo_arl', 'centro_trabajo', 'id_empresa', 'id_persona', 'nit', 'observaciones']);
const camposPublicos = (k) => salud.ENT[k].campos.filter((c) => !NO_PUBLICOS.has(c.n) && !c.n.startsWith('doc_'));
const meta = (k) => camposPublicos(k).map((c) => ({ n: c.n, l: c.l, t: c.t, req: !!c.req, opts: c.opts }));

// El link sirve una sola vez y por 30 minutos. Estado: Vigente | Usado | Vencido | Desactivado.
async function buscarEnlace(token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
  const r = await pool.query(
    `SELECT l.id, l.id_empresa, l.activo, l.pedido_nuevo_en, e.nombre, e.nit,
            GREATEST(0, EXTRACT(EPOCH FROM (l.expira - NOW())))::int AS segundos,
            CASE WHEN NOT l.activo THEN 'Desactivado' WHEN l.usado_en IS NOT NULL THEN 'Usado'
                 WHEN l.expira <= NOW() THEN 'Vencido' ELSE 'Vigente' END AS estado
     FROM ss_enlaces l JOIN ss_empresas e ON e.id = l.id_empresa WHERE l.token = $1`, [token]);
  return r.rows[0] || null;
}
const MSG_ESTADO = {
  Usado: 'Este link ya se usó: la información fue enviada. Si necesitan enviar más, soliciten un link nuevo.',
  Vencido: 'Este link está vencido (dura 30 minutos). Soliciten un link nuevo: lo que alcanzaron a escribir sigue guardado en este navegador.',
  Desactivado: 'Este link fue desactivado. Soliciten un link nuevo.'
};
function noVigente(res, l) {
  if (!l) return res.status(404).json({ error: 'Este link no es válido. Pidan a Genesis Traza el link de su empresa.' });
  return res.status(410).json({ error: MSG_ESTADO[l.estado], estado: l.estado, empresa: { nombre: l.nombre, nit: l.nit }, pedido: !!l.pedido_nuevo_en });
}

// GET /salud-publico/:token -> datos para armar el formulario
router.get('/:token', asyncRoute(async (req, res) => {
  const l = await buscarEnlace(req.params.token);
  if (!l || l.estado !== 'Vigente') return noVigente(res, l);
  res.json({
    empresa: { nombre: l.nombre, nit: l.nit }, segundos: l.segundos,
    campos: { empresa: meta('empresas'), recicladores: meta('recicladores'), trabajadores: meta('trabajadores'), beneficiarios: meta('beneficiarios').filter((c) => c.n !== 'id_persona') },
    documentos: DOCS
  });
}));

// POST /salud-publico/:token (multipart: "datos" JSON + archivos por tipo de documento)
// POST /salud-publico/:token/solicitar-nuevo -> la empresa avisa que necesita otro link
router.post('/:token/solicitar-nuevo', limitarEnvios, asyncRoute(async (req, res) => {
  const l = await buscarEnlace(req.params.token);
  if (!l) return res.status(404).json({ error: 'Este link no es válido.' });
  if (l.estado === 'Vigente') return res.status(409).json({ error: 'Este link todavía está vigente.' });
  await pool.query('UPDATE ss_enlaces SET pedido_nuevo_en = NOW() WHERE id = $1', [l.id]);
  res.json({ ok: true, mensaje: 'Listo: Genesis Traza recibió la solicitud y les enviará un link nuevo.' });
}));

router.post('/:token', limitarEnvios, upload.any(), asyncRoute(async (req, res) => {
  const l = await buscarEnlace(req.params.token);
  if (!l || l.estado !== 'Vigente') return noVigente(res, l);
  let datos;
  try { datos = JSON.parse(req.body.datos || '{}'); } catch (e) { return res.status(400).json({ error: 'Los datos llegaron mal. Recarga e intenta de nuevo.' }); }
  const errores = [];
  const quien = datos.diligencia || {};
  const nombreQ = String(quien.nombre || '').trim().slice(0, 150), cargoQ = String(quien.cargo || '').trim().slice(0, 100), telQ = String(quien.telefono || '').trim().slice(0, 30);
  if (!nombreQ) errores.push('Escribe el nombre de quien diligencia el formulario.');
  if (datos.acepta !== true) errores.push('Debes aceptar la declaración de tratamiento de datos.');

  const limpio = { empresa: {}, recicladores: [], trabajadores: [], beneficiarios: [] };
  // Empresa: solo los campos enviados (todos opcionales aqui; el nombre se conserva si viene vacio).
  const ce = camposPublicos('empresas').map((c) => Object.assign({}, c, { req: false }));
  const re = await salud.limpiar({ campos: ce }, datos.empresa || {}, false);
  re.errores.forEach((x) => errores.push('Empresa: ' + x));
  Object.keys(re.valores).forEach((k) => { if (re.valores[k] !== null && re.valores[k] !== '') limpio.empresa[k] = re.valores[k]; });

  const docsVistos = { recicladores: new Set(), trabajadores: new Set() };
  for (const k of ['recicladores', 'trabajadores']) {
    const filas = Array.isArray(datos[k]) ? datos[k] : [];
    if (filas.length > MAX_PERSONAS) { errores.push(`Máximo ${MAX_PERSONAS} ${k} por envío.`); continue; }
    const cs = camposPublicos(k).filter((c) => c.t !== 'ref');
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i] || {};
      if (!Object.values(f).some((v) => v !== null && v !== '' && v !== false)) continue; // fila vacia
      const r = await salud.limpiar({ campos: cs }, f, true);
      r.errores.forEach((x) => errores.push(`${k === 'recicladores' ? 'Recicladores' : 'Trabajadores'}, fila ${i + 1}: ${x}`));
      const clave = (r.valores.tipo_doc || '') + ':' + (r.valores.nro_doc || '');
      if (docsVistos[k].has(clave)) errores.push(`${k === 'recicladores' ? 'Recicladores' : 'Trabajadores'}, fila ${i + 1}: el documento ${r.valores.nro_doc} está repetido.`);
      docsVistos[k].add(clave);
      if (!r.errores.length) limpio[k].push(r.valores);
      if (errores.length > 40) break;
    }
  }
  const bens = Array.isArray(datos.beneficiarios) ? datos.beneficiarios : [];
  const cb = camposPublicos('beneficiarios').filter((c) => c.t !== 'ref');
  for (let i = 0; i < bens.length && errores.length <= 40; i++) {
    const f = bens[i] || {};
    if (!Object.values(f).some((v) => v !== null && v !== '' && v !== false)) continue;
    const titular = String(f.titular_nro_doc || '').replace(/[^0-9A-Za-z]/g, '');
    if (!titular) errores.push(`Beneficiarios, fila ${i + 1}: escribe el documento del titular.`);
    const r = await salud.limpiar({ campos: cb }, f, true);
    r.errores.forEach((x) => errores.push(`Beneficiarios, fila ${i + 1}: ${x}`));
    if (!r.errores.length && titular) limpio.beneficiarios.push(Object.assign({ titular_nro_doc: titular }, r.valores));
  }
  if (errores.length) return res.status(400).json({ error: errores[0], detalles: errores.slice(0, 40) });

  const archivos = (req.files || []);
  if (!Object.keys(limpio.empresa).length && !limpio.recicladores.length && !limpio.trabajadores.length && !limpio.beneficiarios.length && !archivos.length) {
    return res.status(400).json({ error: 'El formulario está vacío.' });
  }
  // 1) Primero se suben los archivos: si alguno falla (danado, formato), se avisa y el link NO se gasta.
  const subidos = [];
  for (const f of archivos) {
    try {
      const r = await new Promise((resolve, reject) => {
        const st = cloudinary.uploader.upload_stream({ folder: 'genesis/salud_documentos', resource_type: 'auto' }, (err, x) => (err ? reject(err) : resolve(x)));
        st.end(f.buffer);
      });
      subidos.push({ f, url: r.secure_url, publicId: r.public_id, tipo: r.resource_type });
    } catch (e) {
      for (const s of subidos) { try { await cloudinary.uploader.destroy(s.publicId, { resource_type: s.tipo }); } catch (x) { /* huerfano, no critico */ } }
      return res.status(400).json({ error: `No se pudo subir el archivo "${f.originalname}" (${DOCS[f.fieldname]}). Revisen que no esté dañado y que sea PDF, JPG o PNG.` });
    }
  }
  // 2) Reclama el link (un solo uso) de forma atomica y guarda todo en una transaccion.
  const client = await pool.connect();
  let sol;
  try {
    await client.query('BEGIN');
    const reclamo = await client.query('UPDATE ss_enlaces SET usado_en = NOW(), envios = envios + 1, ultimo_envio = NOW() WHERE id = $1 AND usado_en IS NULL AND activo AND expira > NOW() RETURNING id', [l.id]);
    if (!reclamo.rowCount) {
      await client.query('ROLLBACK');
      for (const s of subidos) { try { await cloudinary.uploader.destroy(s.publicId, { resource_type: s.tipo }); } catch (x) { /* no critico */ } }
      return noVigente(res, await buscarEnlace(req.params.token));
    }
    sol = (await client.query(
      `INSERT INTO ss_solicitudes (id_enlace, id_empresa, datos, diligenciado_por, cargo_diligencia, telefono_diligencia, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [l.id, l.id_empresa, JSON.stringify(limpio), nombreQ, cargoQ || null, telQ || null, req.ip])).rows[0].id;
    for (const s of subidos) {
      await client.query('INSERT INTO ss_documentos (id_empresa, id_solicitud, tipo, nombre, archivo_url) VALUES ($1,$2,$3,$4,$5)',
        [l.id_empresa, sol, s.f.fieldname, String(s.f.originalname).slice(0, 255), s.url]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  res.json({ ok: true, folio: 'SAL-' + String(sol).padStart(6, '0'),
    resumen: { recicladores: limpio.recicladores.length, trabajadores: limpio.trabajadores.length, beneficiarios: limpio.beneficiarios.length, documentos: archivos.length } });
}));

module.exports = router;
