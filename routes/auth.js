const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // código de 6 dígitos
}

async function verifyRecaptcha(token) {
  if (!token) return false;
  const params = new URLSearchParams({ secret: process.env.RECAPTCHA_SECRET_KEY, response: token });
  const r = await fetch('https://www.google.com/recaptcha/api/siteverify', { method: 'POST', body: params });
  const data = await r.json();
  return !!data.success;
}

// POST /auth/register  -> crea usuario + asociación, envía código por correo
router.post('/register', asyncRoute(async (req, res) => {
  const { fullName, email, phone, password, associationName, nit, recyclerCount, recaptchaToken } = req.body;

  if (!fullName || !email || !password || !associationName || !nit || !phone || !recyclerCount) {
    return res.status(400).json({ error: 'Faltan campos obligatorios del formulario.' });
  }

  if (!(await verifyRecaptcha(recaptchaToken))) {
    return res.status(400).json({ error: 'Confirma que no eres un robot.' });
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
  }

  const assocResult = await pool.query(
    'INSERT INTO associations (name, nit, recycler_count) VALUES ($1,$2,$3) RETURNING id',
    [associationName, nit || null, recyclerCount || 0]
  );
  const associationId = assocResult.rows[0].id;

  const passwordHash = await bcrypt.hash(password, 10);
  const userResult = await pool.query(
    `INSERT INTO users (association_id, full_name, email, phone, password_hash, role, is_verified)
     VALUES ($1,$2,$3,$4,$5,'operativo',false) RETURNING id`,
    [associationId, fullName, email.toLowerCase(), phone || null, passwordHash]
  );
  const userId = userResult.rows[0].id;

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos
  await pool.query(
    'INSERT INTO verification_codes (user_id, code, expires_at) VALUES ($1,$2,$3)',
    [userId, code, expiresAt]
  );

  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'Genesis Traza <no-reply@genesis-traza.com>',
    to: email,
    subject: 'Tu código de verificación - Genesis Traza',
    html: `<p>Hola ${fullName},</p><p>Tu código de verificación es:</p><h2 style="letter-spacing:4px;">${code}</h2><p>Vence en 15 minutos.</p>`
  });

  await logActivity(userId, 'registro_iniciado', { email });
  res.json({ message: 'Cuenta creada. Revisa tu correo para el código de verificación.', userId });
}));

// POST /auth/resend-code -> genera un nuevo código de verificación y lo reenvía por correo
router.post('/resend-code', asyncRoute(async (req, res) => {
  const { email } = req.body;
  const userResult = await pool.query(
    'SELECT id, full_name FROM users WHERE email = $1 AND is_verified = false',
    [(email || '').toLowerCase()]
  );
  const user = userResult.rows[0];
  if (!user) {
    return res.status(404).json({ error: 'No hay una cuenta pendiente de verificación con ese correo.' });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await pool.query(
    'INSERT INTO verification_codes (user_id, code, expires_at) VALUES ($1,$2,$3)',
    [user.id, code, expiresAt]
  );

  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'Genesis Traza <no-reply@genesis-traza.com>',
    to: email,
    subject: 'Tu nuevo código de verificación - Genesis Traza',
    html: `<p>Hola ${user.full_name},</p><p>Tu código de verificación es:</p><h2 style="letter-spacing:4px;">${code}</h2><p>Vence en 15 minutos.</p>`
  });

  res.json({ message: 'Código reenviado. Revisa tu correo.', userId: user.id });
}));

// POST /auth/verify  -> confirma el código de 6 dígitos
router.post('/verify', asyncRoute(async (req, res) => {
  const { userId, code } = req.body;
  const result = await pool.query(
    `SELECT * FROM verification_codes
     WHERE user_id = $1 AND code = $2 AND used = false AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    [userId, code]
  );
  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Código incorrecto o vencido.' });
  }
  await pool.query('UPDATE verification_codes SET used = true WHERE id = $1', [result.rows[0].id]);
  const userResult = await pool.query(
    'UPDATE users SET is_verified = true WHERE id = $1 RETURNING id, role, association_id, full_name',
    [userId]
  );
  const user = userResult.rows[0];
  await logActivity(userId, 'correo_verificado', {});

  const token = jwt.sign(
    { id: user.id, role: user.role, associationId: user.association_id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ message: 'Correo verificado.', token, role: user.role, fullName: user.full_name });
}));

// POST /auth/login
router.post('/login', asyncRoute(async (req, res) => {
  const { email, password, recaptchaToken } = req.body;

  if (!(await verifyRecaptcha(recaptchaToken))) {
    return res.status(400).json({ error: 'Confirma que no eres un robot.' });
  }

  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  if (!user.is_verified) {
    return res.status(403).json({ error: 'Debes verificar tu correo antes de ingresar.' });
  }
  const token = jwt.sign(
    { id: user.id, role: user.role, associationId: user.association_id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  await logActivity(user.id, 'inicio_sesion', {}, req.ip);
  res.json({ token, role: user.role, fullName: user.full_name });
}));

// GET /auth/me -> datos del usuario logueado + su asociación, suscripciones y pagos
router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const userResult = await pool.query(
    'SELECT id, full_name, email, phone, role, is_verified, association_id, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  const user = userResult.rows[0];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

  let association = null;
  let subscriptions = [];
  let payments = [];
  let routes = [];

  if (user.association_id) {
    const assocResult = await pool.query('SELECT * FROM associations WHERE id = $1', [user.association_id]);
    association = assocResult.rows[0] || null;

    const subsResult = await pool.query(
      `SELECT s.id, s.status, s.billing_cycle, s.next_due_date, s.created_at,
              p.id AS plan_id, p.name AS plan_name, p.category, p.price_monthly, p.price_annual
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.association_id = $1 ORDER BY s.created_at DESC`,
      [user.association_id]
    );
    subscriptions = subsResult.rows;

    const paymentsResult = await pool.query(
      `SELECT pay.id, pay.amount, pay.status, pay.payment_method, pay.paid_at, pay.created_at, p.name AS plan_name
       FROM payments pay
       JOIN subscriptions s ON s.id = pay.subscription_id
       JOIN plans p ON p.id = s.plan_id
       WHERE s.association_id = $1 ORDER BY pay.created_at DESC LIMIT 50`,
      [user.association_id]
    );
    payments = paymentsResult.rows;

    const routesResult = await pool.query(
      'SELECT id, reciclador_name, kml_url, notes FROM association_routes WHERE association_id = $1 ORDER BY reciclador_name',
      [user.association_id]
    );
    routes = routesResult.rows;
  }

  res.json({ user, association, subscriptions, payments, routes });
}));

module.exports = router;
