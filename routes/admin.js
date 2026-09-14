const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();

// 'pro' ve y controla todo. 'admin' (sub-jefes) es operativo: ve datos pero no configuración global.
router.use(requireAuth, requireRole('pro', 'admin'));

// POST /admin/associations -> crear una asociación nueva (y opcionalmente su primer usuario).
// Disponible para 'pro' y 'admin' (a diferencia de otras acciones de configuración).
router.post('/associations', asyncRoute(async (req, res) => {
  const { name, nit, recyclerCount, facturacionUrl, contactFullName, contactEmail, contactPhone, contactPassword } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'El nombre de la asociación es obligatorio.' });
  }

  const assocResult = await pool.query(
    `INSERT INTO associations (name, nit, recycler_count, facturacion_url) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name, nit || null, recyclerCount || 0, facturacionUrl || null]
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

// GET /admin/associations -> lista de asociaciones con su estado de pago
router.get('/associations', asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT a.id, a.name, a.nit, a.recycler_count,
           s.status AS subscription_status, s.next_due_date, p.name AS plan_name
    FROM associations a
    LEFT JOIN subscriptions s ON s.association_id = a.id
    LEFT JOIN plans p ON p.id = s.plan_id
    ORDER BY a.created_at DESC
  `);
  res.json(result.rows);
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
router.put('/associations/:id', requireRole('pro'), asyncRoute(async (req, res) => {
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

// POST /admin/associations/:id/send-reminder -> envía manualmente un correo de recordatorio de pago
router.post('/associations/:id/send-reminder', asyncRoute(async (req, res) => {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const target = await pool.query(
    `SELECT u.email, u.full_name, a.name AS association_name, p.name AS plan_name, s.next_due_date, s.status
     FROM associations a
     LEFT JOIN users u ON u.association_id = a.id AND u.role = 'operativo'
     LEFT JOIN subscriptions s ON s.association_id = a.id
     LEFT JOIN plans p ON p.id = s.plan_id
     WHERE a.id = $1
     ORDER BY s.created_at DESC LIMIT 1`,
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
    html: `<p>Hola ${row.full_name},</p>
           <p>Te escribimos para recordarte tu pago${row.plan_name ? ' del plan <strong>' + row.plan_name + '</strong>' : ''} de <strong>${row.association_name}</strong>${row.next_due_date ? ' con vencimiento el ' + row.next_due_date : ''}.</p>
           <p>Ingresa a tu cuenta en Genesis Traza para ponerte al día y evitar la suspensión del servicio.</p>`
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

module.exports = router;
