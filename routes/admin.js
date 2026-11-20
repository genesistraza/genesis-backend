const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../db/pool');
const cloudinary = require('../db/cloudinary');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');
const { getMassBalanceSummary, getMassBalancePeriods, getRecicladoresConPagoMes } = require('../db/massBalanceQueries');
const { buildPaymentReminderEmail } = require('../utils/emailTemplate');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Los exportes de balance de masas de un año completo pueden pesar bastante mas que un PDF/KML normal.
const uploadExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });
// Logos: solo imagenes rasterizadas (nada de SVG, que puede llevar scripts y los PDF no lo leen).
const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype))
});

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// El link de facturacion debe ser https (es a donde se manda al cliente al iniciar sesion).
const urlFacturacionValida = (u) => { try { return new URL(String(u)).protocol === 'https:'; } catch (e) { return false; } };
const TIPOS_SERVICIO = ['facturacion', 'completo'];

function normalizeRowKeys(row) {
  const out = {};
  for (const key in row) out[key.trim()] = row[key];
  return out;
}
// Devuelve 'YYYY-MM-DD' (no un objeto Date) usando los componentes UTC: XLSX arma las fechas
// de Excel en UTC, y si se le pasa un Date crudo a pg, "pg" lo serializa con la hora local del
// servidor y en zonas horarias detras de UTC (como Bogota, UTC-5) la fecha termina corriéndose
// un dia hacia atras. Con un string 'YYYY-MM-DD' Postgres lo toma literal, sin conversion.
function toDateValue(v) {
  let d = null;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === 'string' && v.trim()) {
    const parsed = new Date(v);
    if (!isNaN(parsed)) d = parsed;
  }
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function toNumberValue(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function toTextValue(v) {
  return v === null || v === undefined || v === '' ? null : String(v);
}
async function bulkInsert(client, table, columns, rows) {
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const placeholders = chunk.map((row, idx) => {
      const base = idx * columns.length;
      columns.forEach((col) => values.push(row[col]));
      return '(' + columns.map((_, k) => '$' + (base + k + 1)).join(',') + ')';
    }).join(',');
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, values);
  }
}

// Borra de Cloudinary una imagen ya reemplazada o quitada (best-effort: si falla, no rompe nada).
async function destroyCloudinaryImage(url) {
  if (!url) return;
  const m = String(url).match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/i);
  if (!m) return;
  try { await cloudinary.uploader.destroy(m[1], { resource_type: 'image' }); } catch (e) { /* imagen huerfana, no es critico */ }
}

function uploadToCloudinary(fileBuffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder, resource_type: 'auto' }, (err, result) => {
      if (err) return reject(err);
      resolve(result.secure_url);
    });
    stream.end(fileBuffer);
  });
}

// 'pro' ve y controla todo. 'admin' (sub-jefes) es operativo: ve datos pero no configuración global.
router.use(requireAuth, requireRole('pro', 'admin'));

// ---- Permisos de cada asesor: el fundador decide que puede y que no (users.permisos_admin) ----
// 'defecto' es lo que tiene un asesor nuevo si el fundador no cambia nada.
const PERMISOS_ASESOR = [
  { clave: 'crear_asociaciones', nombre: 'Crear asociaciones', defecto: true },
  { clave: 'editar_asociaciones', nombre: 'Editar datos y logo de asociaciones', defecto: true },
  { clave: 'link_facturacion', nombre: 'Cambiar tipo de cliente y link de facturación', defecto: false },
  { clave: 'eliminar_asociaciones', nombre: 'Eliminar asociaciones', defecto: false },
  { clave: 'usuarios_asociacion', nombre: 'Crear y corregir usuarios de asociaciones', defecto: true },
  { clave: 'documentos', nombre: 'Subir documentos legales', defecto: true },
  { clave: 'mapas_rutas', nombre: 'Subir y quitar mapas de rutas', defecto: true },
  { clave: 'planes', nombre: 'Activar o quitar planes', defecto: true },
  { clave: 'pagos', nombre: 'Ver pagos y registrar pagos en efectivo', defecto: true },
  { clave: 'limpiar_pagos', nombre: 'Limpiar pagos pendientes', defecto: false },
  { clave: 'recordatorios', nombre: 'Enviar recordatorios de pago', defecto: true },
  { clave: 'balance_masas', nombre: 'Subir balance de masas y recicladores', defecto: true },
  { clave: 'ver_ingresos', nombre: 'Ver resumen de ingresos', defecto: false }
];
function armarPermisos(guardados) {
  const g = guardados && typeof guardados === 'object' ? guardados : {};
  const out = {};
  PERMISOS_ASESOR.forEach((p) => { out[p.clave] = typeof g[p.clave] === 'boolean' ? g[p.clave] : p.defecto; });
  return out;
}
function limpiarPermisos(entrada) {
  const out = {};
  PERMISOS_ASESOR.forEach((p) => { if (entrada && typeof entrada[p.clave] === 'boolean') out[p.clave] = entrada[p.clave]; });
  return armarPermisos(out);
}
// Se leen de la base en cada peticion: si el fundador quita algo, aplica de una vez.
router.use(asyncRoute(async (req, res, next) => {
  if (req.user.role === 'pro') {
    req.permisos = {};
    PERMISOS_ASESOR.forEach((p) => { req.permisos[p.clave] = true; });
  } else {
    const r = await pool.query('SELECT permisos_admin FROM users WHERE id = $1', [req.user.id]);
    req.permisos = armarPermisos(r.rows[0] && r.rows[0].permisos_admin);
  }
  next();
}));
const puede = (clave) => (req, res, next) =>
  (req.permisos && req.permisos[clave]) ? next() : res.status(403).json({ error: 'El fundador no te dio permiso para esta acción.' });

// GET /admin/mis-permisos -> para que el panel muestre solo lo que el usuario puede hacer
router.get('/mis-permisos', (req, res) => {
  res.json({ esPro: req.user.role === 'pro', permisos: req.permisos, catalogo: PERMISOS_ASESOR });
});

// POST /admin/associations -> crear una asociación nueva (y opcionalmente su primer usuario).
// Disponible para 'pro' y 'admin' (a diferencia de otras acciones de configuración).
router.post('/associations', puede('crear_asociaciones'), asyncRoute(async (req, res) => {
  const { name, nit, recyclerCount, contactFullName, contactEmail, contactPhone, contactPassword } = req.body;
  // Sin el permiso 'link_facturacion' el asesor crea la asociacion sin link y como sistema completo.
  const facturacionUrl = req.permisos.link_facturacion ? req.body.facturacionUrl : null;
  const tipoServicio = req.permisos.link_facturacion && TIPOS_SERVICIO.includes(req.body.tipoServicio) ? req.body.tipoServicio : 'completo';
  if (facturacionUrl && !urlFacturacionValida(facturacionUrl)) return res.status(400).json({ error: 'El link de facturación debe empezar por https://' });
  if (tipoServicio === 'facturacion' && !facturacionUrl) return res.status(400).json({ error: 'Un cliente de solo facturación necesita su link de facturación.' });
  if (!name || !nit || !recyclerCount) {
    return res.status(400).json({ error: 'Nombre, NIT y número de recicladores son obligatorios.' });
  }
  if (typeof name !== 'string' || typeof nit !== 'string') {
    return res.status(400).json({ error: 'Nombre y NIT deben ser texto.' });
  }
  const recyclers = Number(recyclerCount);
  if (!Number.isInteger(recyclers) || recyclers < 1 || recyclers > 100000) {
    return res.status(400).json({ error: 'El número de recicladores debe ser un entero positivo.' });
  }

  // Todo el contacto se valida ANTES de crear nada, y asociacion + usuario van en una transaccion:
  // antes, un correo repetido devolvia error pero la asociacion ya habia quedado creada.
  const wantsUser = !!(contactFullName && contactEmail && contactPassword);
  if (wantsUser) {
    if (!EMAIL_RE.test(String(contactEmail).trim())) return res.status(400).json({ error: 'El correo del contacto no es válido.' });
    if (String(contactPassword).length < MIN_PASSWORD) return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` });
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [String(contactEmail).trim().toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
    }
  }

  let association = null;
  let user = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const assocResult = await client.query(
      `INSERT INTO associations (name, nit, recycler_count, facturacion_url, tipo_servicio) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name.trim(), nit.trim(), recyclers, facturacionUrl || null, tipoServicio]
    );
    association = assocResult.rows[0];
    // Sistema completo: queda habilitada de una vez en Registro, con su centro propio.
    if (tipoServicio === 'completo') await client.query(
      `INSERT INTO tz_centros (desc_centro, nit, association_id, modulo, pct_rechazo_estimado) VALUES ($1,$2,$3,'sistema',1.8)`,
      [association.name, association.nit, association.id]);
    if (wantsUser) {
      const bcrypt = require('bcryptjs');
      const passwordHash = await bcrypt.hash(String(contactPassword), 10);
      const userResult = await client.query(
        `INSERT INTO users (association_id, full_name, email, phone, password_hash, role, is_verified)
         VALUES ($1,$2,$3,$4,$5,'operativo',true) RETURNING id, full_name, email, role`,
        [association.id, String(contactFullName).trim(), String(contactEmail).trim().toLowerCase(), contactPhone || null, passwordHash]
      );
      user = userResult.rows[0];
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
    throw e;
  } finally {
    client.release();
  }

  await logActivity(req.user.id, 'asociacion_creada', { associationId: association.id }, req.ip);
  res.json({ association, user });
}));

// GET /admin/associations -> lista de asociaciones con su estado de pago.
// Una asociacion puede acumular varias filas en "subscriptions" con el tiempo (intentos de
// compra abandonados, planes cancelados, etc). El LATERAL JOIN se queda con una sola por
// asociacion: la activa si existe, si no la mas reciente. Sin esto, el LEFT JOIN normal
// devolvia una fila por cada suscripcion y la asociacion se veia "duplicada" en la tabla.
router.get('/associations', asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT a.id, a.name, a.nit, a.recycler_count, a.routes_kml_url, a.logo_url, a.tipo_servicio,
           s.status AS subscription_status, s.next_due_date, p.name AS plan_name
    FROM associations a
    LEFT JOIN LATERAL (
      SELECT * FROM subscriptions s2
      WHERE s2.association_id = a.id
      ORDER BY (s2.status = 'activa') DESC, s2.created_at DESC
      LIMIT 1
    ) s ON true
    LEFT JOIN plans p ON p.id = s.plan_id
    ORDER BY a.created_at DESC
  `);
  res.json(result.rows);
}));

// POST /admin/associations/:id/logo -> sube el logo de la asociacion (png/jpg/webp, hasta 3 MB).
// Cloudinary lo reduce a maximo 600x600 y lo guarda como PNG (conserva transparencia y es un
// formato que tambien pueden incrustar los PDF de facturas y planillas).
router.post('/associations/:id/logo', puede('editar_asociaciones'), uploadLogo.single('logo'), asyncRoute(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Sube una imagen PNG, JPG o WEBP de hasta 3 MB.' });
  }
  // Se comprueba que la asociacion exista ANTES de subir a Cloudinary (si no, queda una imagen huerfana).
  const exists = Number.isInteger(Number(req.params.id)) && (await pool.query('SELECT 1 FROM associations WHERE id = $1', [req.params.id])).rows.length > 0;
  if (!exists) return res.status(404).json({ error: 'Asociación no encontrada.' });
  const logoUrl = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `genesis-traza/associations/${req.params.id}/logo`,
        resource_type: 'image',
        format: 'png',
        transformation: [{ width: 600, height: 600, crop: 'limit' }]
      },
      (err, result) => (err ? reject(err) : resolve(result.secure_url))
    );
    stream.end(req.file.buffer);
  });
  const previous = await pool.query('SELECT logo_url FROM associations WHERE id = $1', [req.params.id]);
  const result = await pool.query('UPDATE associations SET logo_url = $1 WHERE id = $2 RETURNING id, name, logo_url', [logoUrl, req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Asociación no encontrada.' });
  await destroyCloudinaryImage(previous.rows[0] && previous.rows[0].logo_url);
  await logActivity(req.user.id, 'logo_asociacion_subido', { associationId: Number(req.params.id) }, req.ip);
  res.json(result.rows[0]);
}));

// DELETE /admin/associations/:id/logo -> quita el logo (vuelve a mostrarse el avatar con iniciales)
router.delete('/associations/:id/logo', puede('editar_asociaciones'), asyncRoute(async (req, res) => {
  const previous = await pool.query('SELECT logo_url FROM associations WHERE id = $1', [req.params.id]);
  const result = await pool.query('UPDATE associations SET logo_url = NULL WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Asociación no encontrada.' });
  await destroyCloudinaryImage(previous.rows[0] && previous.rows[0].logo_url);
  await logActivity(req.user.id, 'logo_asociacion_eliminado', { associationId: Number(req.params.id) }, req.ip);
  res.json({ message: 'Logo eliminado.' });
}));

// POST /admin/associations/:id/routes-map -> sube el KML/KMZ con todas las rutas de la asociación (un solo archivo)
router.post('/associations/:id/routes-map', puede('mapas_rutas'), upload.single('kml'), asyncRoute(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Falta el archivo KML/KMZ.' });
  }
  const kmlUrl = await uploadToCloudinary(req.file.buffer, `genesis-traza/associations/${req.params.id}/routes`);
  const result = await pool.query(
    'UPDATE associations SET routes_kml_url = $1 WHERE id = $2 RETURNING *',
    [kmlUrl, req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Asociación no encontrada.' });
  await logActivity(req.user.id, 'mapa_rutas_subido', { associationId: Number(req.params.id) }, req.ip);
  res.json(result.rows[0]);
}));

// DELETE /admin/associations/:id/routes-map -> quita el mapa de rutas de la asociación
router.delete('/associations/:id/routes-map', puede('mapas_rutas'), asyncRoute(async (req, res) => {
  const result = await pool.query(
    'UPDATE associations SET routes_kml_url = NULL WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Asociación no encontrada.' });
  await logActivity(req.user.id, 'mapa_rutas_eliminado', { associationId: Number(req.params.id) }, req.ip);
  res.json({ message: 'Mapa de rutas eliminado.' });
}));

// GET /admin/payments -> quién pagó y quién no
router.get('/payments', puede('pagos'), asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT pay.id, pay.amount, pay.status, pay.payment_method, pay.paid_at,
           a.name AS association_name, p.name AS plan_name
    FROM payments pay
    JOIN subscriptions s ON s.id = pay.subscription_id
    JOIN associations a ON a.id = s.association_id
    JOIN plans p ON p.id = s.plan_id
    ORDER BY pay.created_at DESC
    LIMIT 200
  `);
  res.json(result.rows);
}));

// GET /admin/associations/:id -> detalle completo de una asociación (para soporte técnico).
// Queda registrado en activity_logs quién vio a qué cliente y cuándo.
router.get('/associations/:id', asyncRoute(async (req, res) => {
  const associationId = req.params.id;
  const association = await pool.query('SELECT * FROM associations WHERE id = $1', [associationId]);
  if (association.rows.length === 0) {
    return res.status(404).json({ error: 'Asociación no encontrada.' });
  }
  const users = await pool.query(
    'SELECT id, full_name, email, phone, role, is_verified, created_at FROM users WHERE association_id = $1 ORDER BY created_at',
    [associationId]
  );
  const subscriptions = await pool.query(
    `SELECT s.id, s.status, s.billing_cycle, s.next_due_date, s.created_at, p.name AS plan_name
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.association_id = $1 ORDER BY s.created_at DESC`,
    [associationId]
  );
  const payments = await pool.query(
    `SELECT pay.id, pay.amount, pay.status, pay.payment_method, pay.paid_at, pay.created_at
     FROM payments pay JOIN subscriptions s ON s.id = pay.subscription_id
     WHERE s.association_id = $1 ORDER BY pay.created_at DESC LIMIT 100`,
    [associationId]
  );
  await logActivity(req.user.id, 'admin_vio_cliente', { associationId: Number(associationId) }, req.ip);

  res.json({
    association: association.rows[0],
    users: users.rows,
    subscriptions: subscriptions.rows,
    payments: payments.rows
  });
}));

// PUT /admin/associations/:id -> editar datos de una asociación, incluyendo su link único de facturación (solo 'pro')
router.put('/associations/:id', puede('editar_asociaciones'), asyncRoute(async (req, res) => {
  const { name, nit, recyclerCount } = req.body;
  // El link de facturacion y el tipo de cliente: el fundador o el asesor con permiso 'link_facturacion'.
  const esPro = !!req.permisos.link_facturacion;
  const facturacionUrl = esPro ? req.body.facturacionUrl : undefined;
  const tipoServicio = esPro && TIPOS_SERVICIO.includes(req.body.tipoServicio) ? req.body.tipoServicio : null;
  if (facturacionUrl && !urlFacturacionValida(facturacionUrl)) return res.status(400).json({ error: 'El link de facturación debe empezar por https://' });
  const result = await pool.query(
    `UPDATE associations SET
       name = COALESCE($1, name),
       nit = COALESCE($2, nit),
       recycler_count = COALESCE($3, recycler_count),
       facturacion_url = CASE WHEN $6::boolean THEN $4 ELSE facturacion_url END,
       tipo_servicio = COALESCE($7, tipo_servicio)
     WHERE id = $5 RETURNING *`,
    [name, nit, recyclerCount, facturacionUrl || null, req.params.id, facturacionUrl !== undefined, tipoServicio]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Asociación no encontrada.' });
  }
  // Si pasa a sistema completo y no tenia Registro, se le crea su centro.
  if (result.rows[0].tipo_servicio === 'completo') {
    await pool.query(
      `INSERT INTO tz_centros (desc_centro, nit, association_id, modulo, pct_rechazo_estimado)
       SELECT $1, $2, $3, 'sistema', 1.8 WHERE NOT EXISTS (SELECT 1 FROM tz_centros WHERE association_id = $3)`,
      [result.rows[0].name, result.rows[0].nit, result.rows[0].id]);
  }
  await logActivity(req.user.id, 'asociacion_editada', { associationId: Number(req.params.id) }, req.ip);
  res.json(result.rows[0]);
}));

// POST /admin/associations/:id/documents -> sube RUT, Cámara de Comercio y/o cédula del
// representante legal a Cloudinary y guarda los links en la asociación.
router.post('/associations/:id/documents', puede('documentos'),
  upload.fields([{ name: 'rut', maxCount: 1 }, { name: 'camaraComercio', maxCount: 1 }, { name: 'representanteCedula', maxCount: 1 }]),
  asyncRoute(async (req, res) => {
    const folder = `genesis-traza/associations/${req.params.id}`;
    const updates = {};

    if (req.files?.rut?.[0]) updates.rut_url = await uploadToCloudinary(req.files.rut[0].buffer, folder);
    if (req.files?.camaraComercio?.[0]) updates.camara_comercio_url = await uploadToCloudinary(req.files.camaraComercio[0].buffer, folder);
    if (req.files?.representanteCedula?.[0]) updates.representante_cedula_url = await uploadToCloudinary(req.files.representanteCedula[0].buffer, folder);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No se recibió ningún archivo.' });
    }

    const result = await pool.query(
      `UPDATE associations SET
         rut_url = COALESCE($1, rut_url),
         camara_comercio_url = COALESCE($2, camara_comercio_url),
         representante_cedula_url = COALESCE($3, representante_cedula_url)
       WHERE id = $4 RETURNING *`,
      [updates.rut_url || null, updates.camara_comercio_url || null, updates.representante_cedula_url || null, req.params.id]
    );

    await logActivity(req.user.id, 'documentos_asociacion_subidos', { associationId: Number(req.params.id), campos: Object.keys(updates) }, req.ip);
    res.json(result.rows[0]);
  })
);

// DELETE /admin/associations/:id -> elimina una asociación por completo (solo 'pro')
// Cascada: borra sus suscripciones y pagos; a los usuarios ligados les deja association_id en null.
// Nunca se permite borrar una asociación que tenga un usuario 'pro' (protección explícita).
router.delete('/associations/:id', puede('eliminar_asociaciones'), asyncRoute(async (req, res) => {
  const proUser = await pool.query(
    "SELECT id FROM users WHERE association_id = $1 AND role = 'pro'",
    [req.params.id]
  );
  if (proUser.rows.length > 0) {
    return res.status(403).json({ error: 'No se puede eliminar la asociación de una cuenta pro.' });
  }
  const result = await pool.query('DELETE FROM associations WHERE id = $1 RETURNING id, name', [req.params.id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Asociación no encontrada.' });
  }
  await logActivity(req.user.id, 'asociacion_eliminada', { associationId: Number(req.params.id), name: result.rows[0].name }, req.ip);
  res.json({ message: 'Asociación eliminada.' });
}));

// PUT /admin/associations/:id/plan -> corrige manualmente el plan activo de una asociación
// (para arreglar errores: pago con el plan equivocado, ciclo equivocado, etc.). Cancela
// cualquier suscripción activa anterior y activa la nueva de inmediato, sin pasar por Wompi.
router.put('/associations/:id/plan', puede('planes'), asyncRoute(async (req, res) => {
  const { planId, billingCycle } = req.body;
  const cycle = billingCycle === 'anual' ? 'anual' : 'mensual';
  if (!planId) {
    return res.status(400).json({ error: 'Debes indicar el plan.' });
  }
  const plan = await pool.query('SELECT id FROM plans WHERE id = $1', [planId]);
  if (plan.rows.length === 0) {
    return res.status(404).json({ error: 'Plan no encontrado.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE subscriptions SET status='cancelada' WHERE association_id = $1 AND status='activa'`,
      [req.params.id]
    );
    const interval = cycle === 'anual' ? '365 days' : '30 days';
    const inserted = await client.query(
      `INSERT INTO subscriptions (association_id, plan_id, status, billing_cycle, next_due_date)
       VALUES ($1,$2,'activa',$3, NOW() + $4::interval) RETURNING *`,
      [req.params.id, planId, cycle, interval]
    );
    await client.query('COMMIT');
    await logActivity(req.user.id, 'plan_corregido_manualmente', { associationId: Number(req.params.id), planId }, req.ip);
    res.json(inserted.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// DELETE /admin/associations/:id/plan -> quita el plan activo de una asociación (la deja sin plan)
router.delete('/associations/:id/plan', puede('planes'), asyncRoute(async (req, res) => {
  await pool.query(
    `UPDATE subscriptions SET status='cancelada' WHERE association_id = $1 AND status='activa'`,
    [req.params.id]
  );
  await logActivity(req.user.id, 'plan_removido_manualmente', { associationId: Number(req.params.id) }, req.ip);
  res.json({ message: 'Plan removido.' });
}));

// POST /admin/associations/:id/register-payment -> registra un pago recibido por fuera de la
// pasarela (efectivo, transferencia manual, etc). Activa el plan con la fecha de pago indicada
// (no la de hoy) para que el ciclo de cobro arranque desde el dia real en que pagaron, y deja
// el pago guardado como aprobado para que aparezca en el historial y en el resumen de ingresos.
router.post('/associations/:id/register-payment', puede('pagos'), asyncRoute(async (req, res) => {
  const { planId, billingCycle, paidAt } = req.body;
  const cycle = billingCycle === 'anual' ? 'anual' : 'mensual';
  if (!planId || !paidAt) {
    return res.status(400).json({ error: 'Debes indicar el plan y la fecha de pago.' });
  }

  const planResult = await pool.query('SELECT * FROM plans WHERE id = $1', [planId]);
  const plan = planResult.rows[0];
  if (!plan) {
    return res.status(404).json({ error: 'Plan no encontrado.' });
  }
  // price_annual es la tarifa mensual con descuento por pagar anual, no el total del año:
  // el monto que queda registrado es esa tarifa multiplicada por los 12 meses.
  const amount = cycle === 'anual' ? plan.price_annual * 12 : plan.price_monthly;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE subscriptions SET status='cancelada' WHERE association_id = $1 AND status='activa'`,
      [req.params.id]
    );
    const interval = cycle === 'anual' ? '365 days' : '30 days';
    const subResult = await client.query(
      `INSERT INTO subscriptions (association_id, plan_id, status, billing_cycle, next_due_date)
       VALUES ($1,$2,'activa',$3, $4::date + $5::interval) RETURNING id`,
      [req.params.id, planId, cycle, paidAt, interval]
    );
    const subscriptionId = subResult.rows[0].id;
    await client.query(
      `INSERT INTO payments (subscription_id, amount, status, payment_method, paid_at)
       VALUES ($1,$2,'aprobado','Efectivo',$3::date)`,
      [subscriptionId, amount, paidAt]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await logActivity(req.user.id, 'pago_efectivo_registrado', { associationId: Number(req.params.id), planId, amount, paidAt }, req.ip);
  res.json({ message: 'Pago registrado y plan activado.' });
}));

// DELETE /admin/payments/pending -> limpia solicitudes de pago y suscripciones que quedaron
// pendientes y nunca se completaron (basura de intentos de compra abandonados). Solo 'pro'.
router.delete('/payments/pending', puede('limpiar_pagos'), asyncRoute(async (req, res) => {
  // Solo lo abandonado hace mas de 1 dia: un pago pendiente de hace minutos puede estar en pleno
  // checkout de Wompi, y borrarlo dejaria un pago aprobado que el webhook ya no encuentra.
  const payments = await pool.query(`DELETE FROM payments WHERE status = 'pendiente' AND created_at < NOW() - INTERVAL '1 day' RETURNING id`);
  const subs = await pool.query(
    `DELETE FROM subscriptions s WHERE s.status = 'pendiente' AND s.created_at < NOW() - INTERVAL '1 day'
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.subscription_id = s.id) RETURNING s.id`
  );
  await logActivity(req.user.id, 'pagos_pendientes_limpiados', {
    paymentsEliminados: payments.rows.length,
    suscripcionesEliminadas: subs.rows.length
  }, req.ip);
  res.json({ paymentsEliminados: payments.rows.length, suscripcionesEliminadas: subs.rows.length });
}));

// POST /admin/associations/:id/mass-balance -> sube el Excel de balance de masas (formulario_de_masas)
// del sistema de trazabilidad. Reemplaza las filas de esa asociacion dentro del rango de fechas
// que trae el archivo, para poder volver a subirlo sin duplicar filas.
router.post('/associations/:id/mass-balance', puede('balance_masas'), uploadExcel.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo Excel.' });

  const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null }).map(normalizeRowKeys);
  if (rows.length === 0) return res.status(400).json({ error: 'El archivo no tiene filas.' });

  const associationId = Number(req.params.id);
  const parsed = rows.map((r) => ({
    association_id: associationId,
    fecha: toDateValue(r['fecha']),
    semana: toNumberValue(r['Número de semana']),
    reciclador_documento: toTextValue(r['Nro ident.']),
    reciclador_nombre: toTextValue(r['nombre_completo']),
    material_codigo: toTextValue(r['Tipo Material']),
    material_desc: toTextValue(r['desc_tipo_material_padre']),
    toneladas: toNumberValue(r['toneladas']) || 0,
    toneladas_rechazo: toNumberValue(r['Toneladas_rechazo']) || 0,
    valor_kilogramo: toNumberValue(r['valor_kilogramo']),
    valor_total: toNumberValue(r['valor_total']),
    tipo_destino: toTextValue(r['Tipo de destino']),
    sitio_destino: toTextValue(r['Número único del sitio de destino'])
  })).filter((r) => r.fecha);

  if (parsed.length === 0) return res.status(400).json({ error: 'No se pudo leer ninguna fila con fecha válida.' });

  const fechaMin = parsed.reduce((min, r) => (r.fecha < min ? r.fecha : min), parsed[0].fecha);
  const fechaMax = parsed.reduce((max, r) => (r.fecha > max ? r.fecha : max), parsed[0].fecha);

  const columns = ['association_id', 'fecha', 'semana', 'reciclador_documento', 'reciclador_nombre',
    'material_codigo', 'material_desc', 'toneladas', 'toneladas_rechazo', 'valor_kilogramo', 'valor_total',
    'tipo_destino', 'sitio_destino'];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM mass_balance_entries WHERE association_id = $1 AND fecha BETWEEN $2 AND $3',
      [associationId, fechaMin, fechaMax]
    );
    await bulkInsert(client, 'mass_balance_entries', columns, parsed);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await logActivity(req.user.id, 'balance_masas_subido', { associationId, filas: parsed.length }, req.ip);
  res.json({ message: 'Balance de masas actualizado.', filas: parsed.length });
}));

// GET /admin/associations/:id/mass-balance/summary -> resumen del balance de masas de una asociacion.
// Acepta ?period=year|month|week&value=... para acotar a un periodo especifico.
router.get('/associations/:id/mass-balance/summary', asyncRoute(async (req, res) => {
  const summary = await getMassBalanceSummary(Number(req.params.id), req.query.period, req.query.value);
  res.json(summary);
}));

// GET /admin/associations/:id/mass-balance/periods -> años, meses y semanas con datos
router.get('/associations/:id/mass-balance/periods', asyncRoute(async (req, res) => {
  const periods = await getMassBalancePeriods(Number(req.params.id));
  res.json(periods);
}));

// POST /admin/associations/:id/recicladores -> sube el Excel del listado de recicladores.
// Reemplaza por completo el listado de esa asociacion (es una foto del estado actual, no historico).
router.post('/associations/:id/recicladores', puede('balance_masas'), uploadExcel.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo Excel.' });

  const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null }).map(normalizeRowKeys);
  if (rows.length === 0) return res.status(400).json({ error: 'El archivo no tiene filas.' });

  const associationId = Number(req.params.id);
  const parsed = rows.map((r) => ({
    association_id: associationId,
    documento_numero: toTextValue(r['NRO_DOCUMENTO']),
    nombre_completo: toTextValue(r['NOMBRE_COMPLETO']),
    estado: toTextValue(r['ESTADO']) || 'Activo',
    fecha_exp_documento: toDateValue(r['fecha_exp_documento']),
    fecha_nacimiento: toDateValue(r['fecha_nacimiento']),
    direccion: toTextValue(r['DIRECCION']),
    telefono: toTextValue(r['TELEFONO']),
    tipo_vehiculo: toTextValue(r['TIPO_VEHICULO']),
    placa: toTextValue(r['PLACA'])
  })).filter((r) => r.documento_numero && r.nombre_completo);

  if (parsed.length === 0) return res.status(400).json({ error: 'No se pudo leer ningún reciclador válido.' });

  const columns = ['association_id', 'documento_numero', 'nombre_completo', 'estado', 'fecha_exp_documento',
    'fecha_nacimiento', 'direccion', 'telefono', 'tipo_vehiculo', 'placa'];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM recicladores WHERE association_id = $1', [associationId]);
    await bulkInsert(client, 'recicladores', columns, parsed);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await logActivity(req.user.id, 'recicladores_subidos', { associationId, filas: parsed.length }, req.ip);
  res.json({ message: 'Listado de recicladores actualizado.', filas: parsed.length });
}));

// GET /admin/associations/:id/recicladores -> recicladores de una asociacion con toneladas y pago
// del mes (?month=YYYY-MM; por defecto el mes calendario actual)
router.get('/associations/:id/recicladores', asyncRoute(async (req, res) => {
  const data = await getRecicladoresConPagoMes(Number(req.params.id), req.query.month);
  res.json(data);
}));

// POST /admin/associations/:id/send-reminder -> envía manualmente un correo de recordatorio de pago
router.post('/associations/:id/send-reminder', puede('recordatorios'), asyncRoute(async (req, res) => {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const target = await pool.query(
    `SELECT u.email, u.full_name, a.name AS association_name, p.name AS plan_name, s.next_due_date, s.status
     FROM associations a
     LEFT JOIN users u ON u.association_id = a.id AND u.role = 'operativo'
     LEFT JOIN LATERAL (
       SELECT * FROM subscriptions s2
       WHERE s2.association_id = a.id
       ORDER BY (s2.status = 'activa') DESC, s2.created_at DESC
       LIMIT 1
     ) s ON true
     LEFT JOIN plans p ON p.id = s.plan_id
     WHERE a.id = $1`,
    [req.params.id]
  );
  const row = target.rows[0];
  if (!row || !row.email) {
    return res.status(404).json({ error: 'Esta asociación no tiene un usuario con correo para notificar.' });
  }

  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'Genesis Traza <no-reply@genesistraza.com>',
    to: row.email,
    subject: 'Recordatorio de pago - Genesis Traza',
    html: buildPaymentReminderEmail({
      fullName: row.full_name,
      associationName: row.association_name,
      planName: row.plan_name,
      nextDueDate: row.next_due_date,
      extraNote: 'Te escribimos para recordarte tu pago.'
    })
  });

  await logActivity(req.user.id, 'recordatorio_manual_enviado', { associationId: Number(req.params.id), email: row.email }, req.ip);
  res.json({ message: 'Recordatorio enviado a ' + row.email + '.' });
}));

// GET /admin/revenue-summary -> ingresos totales, del mes, y suscripciones activas (solo 'pro')
router.get('/revenue-summary', puede('ver_ingresos'), asyncRoute(async (req, res) => {
  const totals = await pool.query(`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE status = 'aprobado'), 0) AS total_aprobado,
      COALESCE(SUM(amount) FILTER (WHERE status = 'aprobado' AND paid_at >= date_trunc('month', NOW())), 0) AS total_mes_actual,
      COUNT(*) FILTER (WHERE status = 'aprobado') AS pagos_aprobados
    FROM payments
  `);
  const activeSubs = await pool.query(`SELECT COUNT(*) AS activas FROM subscriptions WHERE status = 'activa'`);
  res.json({
    totalAprobado: Number(totals.rows[0].total_aprobado),
    totalMesActual: Number(totals.rows[0].total_mes_actual),
    pagosAprobados: Number(totals.rows[0].pagos_aprobados),
    suscripcionesActivas: Number(activeSubs.rows[0].activas)
  });
}));

// GET /admin/pending-payments -> asociaciones con pago vencido (para recordatorios)
router.get('/pending-payments', puede('pagos'), asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT a.name, a.id AS association_id, s.next_due_date, u.email, u.phone
    FROM subscriptions s
    JOIN associations a ON a.id = s.association_id
    JOIN users u ON u.association_id = a.id AND u.role = 'operativo'
    WHERE s.status = 'vencida' OR (s.status = 'activa' AND s.next_due_date < NOW())
  `);
  res.json(result.rows);
}));

// GET /admin/logs/activity -> historial de acciones (solo 'pro')
router.get('/logs/activity', requireRole('pro'), asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT al.id, al.action, al.details, al.ip_address, al.created_at, u.full_name, u.email
    FROM activity_logs al LEFT JOIN users u ON u.id = al.user_id
    ORDER BY al.created_at DESC LIMIT 300
  `);
  res.json(result.rows);
}));

// GET /admin/logs/errors -> errores técnicos del sistema (solo 'pro')
router.get('/logs/errors', requireRole('pro'), asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM error_logs ORDER BY created_at DESC LIMIT 200');
  res.json(result.rows);
}));

// ---- Asesores Genesis (solo el fundador): lista y movimientos de cada uno ----
const { textoAccion } = require('../utils/actividadTexto');
const ymdValido = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const hoyCO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

// GET /admin/asesores -> asesores creados, con su ultimo ingreso y cuantos movimientos llevan
router.get('/asesores', requireRole('pro'), asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.foto_url, u.activo,
            to_char(u.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS creado,
            (SELECT to_char(max(l.created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI')
               FROM activity_logs l WHERE l.user_id = u.id AND l.action LIKE 'inicio_sesion%') AS ultimo_ingreso,
            (SELECT count(*)::int FROM activity_logs l WHERE l.user_id = u.id) AS movimientos,
            u.permisos_admin
     FROM users u WHERE u.role = 'admin' ORDER BY u.full_name`);
  res.json(r.rows.map((x) => Object.assign(x, { permisos_admin: armarPermisos(x.permisos_admin) })));
}));

// PUT /admin/asesores/:id/permisos -> el fundador decide que puede y que no puede hacer ese asesor
router.put('/asesores/:id/permisos', requireRole('pro'), asyncRoute(async (req, res) => {
  const permisos = limpiarPermisos(req.body.permisos);
  const r = await pool.query("UPDATE users SET permisos_admin = $1 WHERE id = $2 AND role = 'admin' RETURNING id",
    [JSON.stringify(permisos), Number(req.params.id)]);
  if (!r.rows.length) return res.status(404).json({ error: 'Asesor no encontrado.' });
  await logActivity(req.user.id, 'asesor_permisos_cambiados', { asesorId: Number(req.params.id) }, req.ip);
  res.json({ permisos });
}));

// GET /admin/asesores/:id/actividad?desde&hasta -> que hizo ese asesor (hora de Colombia)
router.get('/asesores/:id/actividad', requireRole('pro'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const u = (await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'admin'", [id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Asesor no encontrado.' });
  const desde = ymdValido(req.query.desde) ? req.query.desde : hoyCO();
  const hasta = ymdValido(req.query.hasta) ? req.query.hasta : hoyCO();
  const r = await pool.query(
    `SELECT to_char(l.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS') AS fecha_hora, l.action, l.details, l.ip_address
     FROM activity_logs l WHERE l.user_id = $1
       AND (l.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date BETWEEN $2 AND $3
     ORDER BY l.created_at DESC LIMIT 2000`, [id, desde, hasta]);
  res.json(r.rows.map((x) => ({ fecha_hora: x.fecha_hora, accion: textoAccion(x.action, x.details), ip: x.ip_address })));
}));

// El fundador crea asesores y usuarios de asociacion; el asesor ('admin') solo el usuario de
// ingreso de una asociacion de cliente (nunca asesores ni usuarios del equipo Genesis).
router.post('/users', asyncRoute(async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { fullName, email, password, role, associationId } = req.body;
  if (!['admin', 'operativo'].includes(role)) {
    return res.status(400).json({ error: "El rol debe ser 'admin' (operativo) u 'operativo'." });
  }
  if (req.user.role !== 'pro') {
    if (role !== 'operativo') return res.status(403).json({ error: 'Solo el fundador puede crear asesores.' });
    if (!req.permisos.usuarios_asociacion) return res.status(403).json({ error: 'El fundador no te dio permiso para crear usuarios.' });
    if (!associationId) return res.status(400).json({ error: 'Falta la asociación del usuario.' });
    const equipo = await pool.query(
      "SELECT 1 FROM users WHERE association_id = $1 AND role IN ('pro','admin') LIMIT 1", [associationId]);
    if (equipo.rows.length) return res.status(403).json({ error: 'Esa asociación es del equipo Genesis.' });
  }
  if (typeof fullName !== 'string' || !fullName.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) return res.status(400).json({ error: 'El correo no es válido.' });
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` });
  }
  const emailLower = email.trim().toLowerCase();
  if ((await pool.query('SELECT 1 FROM users WHERE email = $1', [emailLower])).rows.length > 0) {
    return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
  }
  if (associationId && (!Number.isInteger(Number(associationId)) ||
      (await pool.query('SELECT 1 FROM associations WHERE id = $1', [associationId])).rows.length === 0)) {
    return res.status(400).json({ error: 'La asociación indicada no existe.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    // Asesor / administrador ('admin') = perfil ADM_CENTROS del sistema de usuarios (equipo Genesis).
    `INSERT INTO users (full_name, email, password_hash, role, association_id, is_verified, id_perfil, permisos_admin)
     VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING id, full_name, email, role`,
    [fullName.trim(), emailLower, passwordHash, role, role === 'admin' ? (associationId || 1) : (associationId || null), role === 'admin' ? 8 : 9,
     role === 'admin' ? JSON.stringify(limpiarPermisos(req.body.permisos)) : null]
  );
  await logActivity(req.user.id, 'usuario_admin_creado', { nuevo: result.rows[0] });
  res.json(result.rows[0]);
}));

// PUT /admin/users/:id -> corrige el correo y/o celular de contacto de un usuario del cliente
// (para cuando el cliente se equivocó al registrarse y no puede entrar a corregirlo él mismo).
router.put('/users/:id', puede('usuarios_asociacion'), asyncRoute(async (req, res) => {
  const { email, phone } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'El correo es obligatorio.' });
  }
  try {
    // El asesor solo corrige usuarios de asociaciones, nunca al fundador ni a otros asesores.
    const result = await pool.query(
      `UPDATE users SET email = $1, phone = $2 WHERE id = $3 AND ($4::boolean OR role = 'operativo')
       RETURNING id, full_name, email, phone`,
      [email.toLowerCase().trim(), phone ? phone.trim() : null, req.params.id, req.user.role === 'pro']
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    await logActivity(req.user.id, 'usuario_contacto_actualizado', { userId: req.params.id, email, phone }, req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ese correo ya está en uso por otro usuario.' });
    }
    throw err;
  }
}));

// POST /admin/force-logout-all -> invalida de una vez todos los tokens (JWT) emitidos hasta
// ahora, en todos los dispositivos y para todos los usuarios - incluido quien ejecuta esto.
router.post('/force-logout-all', requireRole('pro'), asyncRoute(async (req, res) => {
  await pool.query(
    `INSERT INTO security_settings (id, sessions_invalidated_at) VALUES (1, NOW())
     ON CONFLICT (id) DO UPDATE SET sessions_invalidated_at = NOW()`
  );
  await logActivity(req.user.id, 'sesiones_cerradas_todos_los_dispositivos', {}, req.ip);
  res.json({ message: 'Se cerró la sesión en todos los dispositivos.' });
}));

// GET /admin/notification-settings -> correo y telefono a donde llegan las notificaciones de pago
router.get('/notification-settings', requireRole('pro'), asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT email, phone FROM notification_settings WHERE id = 1');
  res.json(result.rows[0] || { email: null, phone: null });
}));

// PUT /admin/notification-settings -> actualiza el correo y/o telefono de notificaciones (solo 'pro')
router.put('/notification-settings', requireRole('pro'), asyncRoute(async (req, res) => {
  const { email, phone } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'El correo de notificaciones es obligatorio.' });
  }
  const result = await pool.query(
    `INSERT INTO notification_settings (id, email, phone, updated_at) VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET email = $1, phone = $2, updated_at = NOW()
     RETURNING email, phone`,
    [email, phone || null]
  );
  await logActivity(req.user.id, 'notificaciones_configuradas', { email, phone }, req.ip);
  res.json(result.rows[0]);
}));

module.exports = router;
