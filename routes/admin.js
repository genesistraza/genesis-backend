const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();

// 'pro' ve y controla todo. 'admin' (sub-jefes) es operativo: ve datos pero no configuración global.
router.use(requireAuth, requireRole('pro', 'admin'));

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
