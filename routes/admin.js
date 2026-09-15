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

// POST /admin/associations -> crear una asociación nueva (y opcionalmente su primer usuario).
// Disponible para 'pro' y 'admin' (a diferencia de otras acciones de configuración).
router.post('/associations', asyncRoute(async (req, res) => {
  const { name, nit, recyclerCount, facturacionUrl, contactFullName, contactEmail, contactPhone, contactPassword } = req.body;
  if (!name || !nit || !recyclerCount) {
    return res.status(400).json({ error: 'Nombre, NIT y número de recicladores son obligatorios.' });
  }

  const assocResult = await pool.query(
    `INSERT INTO associations (name, nit, recycler_count, facturacion_url) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name, nit, recyclerCount, facturacionUrl || null]
  );
  const association = assocResult.rows[0];

  let user = null;
  if (contactFullName && contactEmail && contactPassword) {
    const bcrypt = require('bcryptjs');
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [contactEmail.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
    }
    const passwordHash = await bcrypt.hash(contactPassword, 10);
    const userResult = await pool.query(
      `INSERT INTO users (association_id, full_name, email, phone, password_hash, role, is_verified)
       VALUES ($1,$2,$3,$4,$5,'operativo',true) RETURNING id, full_name, email, role`,
      [association.id, contactFullName, contactEmail.toLowerCase(), contactPhone || null, passwordHash]
    );
    user = userResult.rows[0];
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
    SELECT a.id, a.name, a.nit, a.recycler_count, a.routes_kml_url,
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

// POST /admin/associations/:id/routes-map -> sube el KML/KMZ con todas las rutas de la asociación (un solo archivo)
router.post('/associations/:id/routes-map', upload.single('kml'), asyncRoute(async (req, res) => {
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
router.delete('/associations/:id/routes-map', asyncRoute(async (req, res) => {
  const result = await pool.query(
    'UPDATE associations SET routes_kml_url = NULL WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Asociación no encontrada.' });
  await logActivity(req.user.id, 'mapa_rutas_eliminado', { associationId: Number(req.params.id) }, req.ip);
  res.json({ message: 'Mapa de rutas eliminado.' });
}));

// GET /admin/payments -> quién pagó y quién no
router.get('/payments', asyncRoute(async (req, res) => {
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
router.put('/associations/:id', asyncRoute(async (req, res) => {
  const { name, nit, recyclerCount, facturacionUrl } = req.body;
  const result = await pool.query(
    `UPDATE associations SET
       name = COALESCE($1, name),
       nit = COALESCE($2, nit),
       recycler_count = COALESCE($3, recycler_count),
       facturacion_url = $4
     WHERE id = $5 RETURNING *`,
    [name, nit, recyclerCount, facturacionUrl || null, req.params.id]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Asociación no encontrada.' });
  }
  await logActivity(req.user.id, 'asociacion_editada', { associationId: Number(req.params.id) }, req.ip);
  res.json(result.rows[0]);
}));

// POST /admin/associations/:id/documents -> sube RUT, Cámara de Comercio y/o cédula del
// representante legal a Cloudinary y guarda los links en la asociación.
router.post('/associations/:id/documents',
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
router.delete('/associations/:id', requireRole('pro'), asyncRoute(async (req, res) => {
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
router.put('/associations/:id/plan', asyncRoute(async (req, res) => {
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
router.delete('/associations/:id/plan', asyncRoute(async (req, res) => {
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
router.post('/associations/:id/register-payment', asyncRoute(async (req, res) => {
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
router.delete('/payments/pending', requireRole('pro'), asyncRoute(async (req, res) => {
  const payments = await pool.query(`DELETE FROM payments WHERE status = 'pendiente' RETURNING id`);
  const subs = await pool.query(`DELETE FROM subscriptions WHERE status = 'pendiente' RETURNING id`);
  await logActivity(req.user.id, 'pagos_pendientes_limpiados', {
    paymentsEliminados: payments.rows.length,
    suscripcionesEliminadas: subs.rows.length
  }, req.ip);
  res.json({ paymentsEliminados: payments.rows.length, suscripcionesEliminadas: subs.rows.length });
}));

// POST /admin/associations/:id/mass-balance -> sube el Excel de balance de masas (formulario_de_masas)
// del sistema de trazabilidad. Reemplaza las filas de esa asociacion dentro del rango de fechas
// que trae el archivo, para poder volver a subirlo sin duplicar filas.
router.post('/associations/:id/mass-balance', uploadExcel.single('file'), asyncRoute(async (req, res) => {
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
router.post('/associations/:id/recicladores', uploadExcel.single('file'), asyncRoute(async (req, res) => {
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
router.post('/associations/:id/send-reminder', asyncRoute(async (req, res) => {
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
router.get('/revenue-summary', requireRole('pro'), asyncRoute(async (req, res) => {
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
router.get('/pending-payments', asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT a.name, a.id AS association_id, s.next_due_date, u.email, u.phone
    FROM subscriptions s
    JOIN associations a ON a.id = s.association_id
    JOIN users u ON u.association_id = a.id AND u.role = 'operativo'
    WHERE s.status = 'vencida' OR s.next_due_date < NOW()
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

// POST /admin/users -> crear un sub-jefe/administrador operativo (solo 'pro')
router.post('/users', requireRole('pro'), asyncRoute(async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { fullName, email, password, role, associationId } = req.body;
  if (!['admin', 'operativo'].includes(role)) {
    return res.status(400).json({ error: "El rol debe ser 'admin' (operativo) u 'operativo'." });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    `INSERT INTO users (full_name, email, password_hash, role, association_id, is_verified)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING id, full_name, email, role`,
    [fullName, email.toLowerCase(), passwordHash, role, associationId || null]
  );
  await logActivity(req.user.id, 'usuario_admin_creado', { nuevo: result.rows[0] });
  res.json(result.rows[0]);
}));

// PUT /admin/users/:id -> corrige el correo y/o celular de contacto de un usuario del cliente
// (para cuando el cliente se equivocó al registrarse y no puede entrar a corregirlo él mismo).
router.put('/users/:id', asyncRoute(async (req, res) => {
  const { email, phone } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'El correo es obligatorio.' });
  }
  try {
    const result = await pool.query(
      'UPDATE users SET email = $1, phone = $2 WHERE id = $3 RETURNING id, full_name, email, phone',
      [email.toLowerCase().trim(), phone ? phone.trim() : null, req.params.id]
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
