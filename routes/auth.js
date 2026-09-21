const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const qrcode = require('qrcode');
const { authenticator } = require('otplib');
const { Resend } = require('resend');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

function generateCode() {
  return String(crypto.randomInt(100000, 1000000)); // código de 6 dígitos (aleatorio criptográfico)
}

function escapeHtml(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function verifyRecaptcha(token) {
  if (!token) return false;
  const params = new URLSearchParams({ secret: process.env.RECAPTCHA_SECRET_KEY, response: token });
  const r = await fetch('https://www.google.com/recaptcha/api/siteverify', { method: 'POST', body: params });
  const data = await r.json();
  return !!data.success;
}

function issueSessionToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, associationId: user.association_id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Limita intentos repetidos de login/registro/reenvio de codigo por IP (ademas del reCAPTCHA).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' }
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera un rato e inténtalo de nuevo.' }
});

// POST /auth/register  -> crea usuario + asociación, envía código por correo
router.post('/register', registerLimiter, asyncRoute(async (req, res) => {
  const { fullName, email, phone, password, associationName, nit, recyclerCount, recaptchaToken, acceptedTerms } = req.body;

  if (!fullName || !email || !password || !associationName || !nit || !phone || !recyclerCount) {
    return res.status(400).json({ error: 'Faltan campos obligatorios del formulario.' });
  }
  if ([fullName, email, password, associationName, nit, phone].some((v) => typeof v !== 'string')) {
    return res.status(400).json({ error: 'Alguno de los datos del formulario no es válido.' });
  }
  if (!EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Escribe un correo válido.' });
  }
  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` });
  }
  const recyclers = Number(recyclerCount);
  if (!Number.isInteger(recyclers) || recyclers < 1 || recyclers > 100000) {
    return res.status(400).json({ error: 'El número de recicladores debe ser un entero positivo.' });
  }

  if (!acceptedTerms) {
    return res.status(400).json({ error: 'Debes aceptar los Términos y Condiciones y la Política de tratamiento de datos.' });
  }

  if (!(await verifyRecaptcha(recaptchaToken))) {
    return res.status(400).json({ error: 'Confirma que no eres un robot.' });
  }

  const emailLower = email.trim().toLowerCase();
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [emailLower]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
  }

  // Asociacion, usuario y codigo en una sola transaccion: si algo falla no queda una asociacion huerfana.
  const passwordHash = await bcrypt.hash(password, 10);
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos
  let userId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const assocResult = await client.query(
      'INSERT INTO associations (name, nit, recycler_count) VALUES ($1,$2,$3) RETURNING id',
      [associationName.trim(), nit.trim(), recyclers]
    );
    const userResult = await client.query(
      `INSERT INTO users (association_id, full_name, email, phone, password_hash, role, is_verified, accepted_terms_at)
       VALUES ($1,$2,$3,$4,$5,'operativo',false,NOW()) RETURNING id`,
      [assocResult.rows[0].id, fullName.trim(), emailLower, phone.trim(), passwordHash]
    );
    userId = userResult.rows[0].id;
    await client.query('INSERT INTO verification_codes (user_id, code, expires_at) VALUES ($1,$2,$3)', [userId, code, expiresAt]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
    throw e;
  } finally {
    client.release();
  }

  await resend.emails.send({
    from: process.env.EMAIL_FROM || 'Genesis Traza <no-reply@genesis-traza.com>',
    to: emailLower,
    subject: 'Tu código de verificación - Genesis Traza',
    html: `<p>Hola ${escapeHtml(fullName)},</p><p>Tu código de verificación es:</p><h2 style="letter-spacing:4px;">${code}</h2><p>Vence en 15 minutos.</p>`
  });

  await logActivity(userId, 'registro_iniciado', { email });
  res.json({ message: 'Cuenta creada. Revisa tu correo para el código de verificación.', userId });
}));

// POST /auth/resend-code -> genera un nuevo código de verificación y lo reenvía por correo
router.post('/resend-code', registerLimiter, asyncRoute(async (req, res) => {
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
    html: `<p>Hola ${escapeHtml(user.full_name)},</p><p>Tu código de verificación es:</p><h2 style="letter-spacing:4px;">${code}</h2><p>Vence en 15 minutos.</p>`
  });

  res.json({ message: 'Código reenviado. Revisa tu correo.', userId: user.id });
}));

// POST /auth/verify  -> confirma el código de 6 dígitos
// Con limite de intentos: un codigo de 6 digitos sin limite se adivina por fuerza bruta y entrega un token.
router.post('/verify', loginLimiter, asyncRoute(async (req, res) => {
  const { userId, code } = req.body;
  if (!Number.isInteger(Number(userId)) || !/^\d{6}$/.test(String(code || ''))) {
    return res.status(400).json({ error: 'Código incorrecto o vencido.' });
  }
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

  const token = issueSessionToken(user);
  res.json({ message: 'Correo verificado.', token, role: user.role, fullName: user.full_name });
}));

// POST /auth/login
router.post('/login', loginLimiter, asyncRoute(async (req, res) => {
  const { email, password, recaptchaToken } = req.body;

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'Escribe tu correo y contraseña.' });
  }
  if (!(await verifyRecaptcha(recaptchaToken))) {
    return res.status(400).json({ error: 'Confirma que no eres un robot.' });
  }

  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  if (!user.is_verified) {
    return res.status(403).json({ error: 'Debes verificar tu correo antes de ingresar.' });
  }

  // Cuentas pro/admin con verificación en dos pasos activada: no se entrega el token todavía.
  if (user.totp_enabled) {
    const pendingToken = jwt.sign(
      { id: user.id, pending2FA: true },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    return res.json({ requires2FA: true, pendingToken });
  }

  const token = issueSessionToken(user);
  await logActivity(user.id, 'inicio_sesion', {}, req.ip);
  res.json({ token, role: user.role, fullName: user.full_name });
}));

// POST /auth/login/2fa -> segundo paso del login para cuentas con verificación en dos pasos
router.post('/login/2fa', loginLimiter, asyncRoute(async (req, res) => {
  const { pendingToken, code } = req.body;
  let payload;
  try {
    payload = jwt.verify(pendingToken, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'La verificación expiró. Inicia sesión de nuevo.' });
  }
  if (!payload.pending2FA) {
    return res.status(401).json({ error: 'Token inválido.' });
  }

  const result = await pool.query('SELECT * FROM users WHERE id = $1', [payload.id]);
  const user = result.rows[0];
  if (!user || !user.totp_enabled || !user.totp_secret) {
    return res.status(401).json({ error: 'Esta cuenta no tiene verificación en dos pasos activa.' });
  }
  if (!code || !authenticator.check(String(code).trim(), user.totp_secret)) {
    return res.status(400).json({ error: 'Código incorrecto.' });
  }

  const token = issueSessionToken(user);
  await logActivity(user.id, 'inicio_sesion_2fa', {}, req.ip);
  res.json({ token, role: user.role, fullName: user.full_name });
}));

// POST /auth/2fa/setup -> genera un secreto pendiente y el QR para activar la verificación en dos pasos (pro/admin)
router.post('/2fa/setup', requireAuth, requireRole('pro', 'admin'), asyncRoute(async (req, res) => {
  const userResult = await pool.query('SELECT email, totp_enabled FROM users WHERE id = $1', [req.user.id]);
  const user = userResult.rows[0];
  if (user.totp_enabled) {
    return res.status(400).json({ error: 'La verificación en dos pasos ya está activa.' });
  }

  const secret = authenticator.generateSecret();
  await pool.query('UPDATE users SET totp_pending_secret = $1 WHERE id = $2', [secret, req.user.id]);

  const otpauth = authenticator.keyuri(user.email, 'Genesis Traza', secret);
  const qrDataUrl = await qrcode.toDataURL(otpauth);

  res.json({ secret, qrDataUrl });
}));

// POST /auth/2fa/confirm -> confirma el codigo generado con el secreto pendiente y activa 2FA
router.post('/2fa/confirm', requireAuth, requireRole('pro', 'admin'), asyncRoute(async (req, res) => {
  const { code } = req.body;
  const userResult = await pool.query('SELECT totp_pending_secret FROM users WHERE id = $1', [req.user.id]);
  const pendingSecret = userResult.rows[0]?.totp_pending_secret;
  if (!pendingSecret) {
    return res.status(400).json({ error: 'No hay una activación en curso. Vuelve a generar el código QR.' });
  }
  if (!code || !authenticator.check(String(code).trim(), pendingSecret)) {
    return res.status(400).json({ error: 'Código incorrecto.' });
  }

  await pool.query(
    'UPDATE users SET totp_secret = $1, totp_pending_secret = NULL, totp_enabled = true WHERE id = $2',
    [pendingSecret, req.user.id]
  );
  await logActivity(req.user.id, '2fa_activado', {}, req.ip);
  res.json({ message: 'Verificación en dos pasos activada.' });
}));

// POST /auth/2fa/disable -> desactiva la verificación en dos pasos (requiere un código válido)
router.post('/2fa/disable', requireAuth, requireRole('pro', 'admin'), asyncRoute(async (req, res) => {
  const { code } = req.body;
  const userResult = await pool.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [req.user.id]);
  const user = userResult.rows[0];
  if (!user.totp_enabled) {
    return res.status(400).json({ error: 'La verificación en dos pasos no está activa.' });
  }
  if (!code || !authenticator.check(String(code).trim(), user.totp_secret)) {
    return res.status(400).json({ error: 'Código incorrecto.' });
  }

  await pool.query(
    'UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = false WHERE id = $1',
    [req.user.id]
  );
  await logActivity(req.user.id, '2fa_desactivado', {}, req.ip);
  res.json({ message: 'Verificación en dos pasos desactivada.' });
}));

// GET /auth/me -> datos del usuario logueado + su asociación, suscripciones y pagos
router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const userResult = await pool.query(
    'SELECT id, full_name, email, phone, role, is_verified, association_id, totp_enabled, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  const user = userResult.rows[0];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

  let association = null;
  let subscriptions = [];
  let payments = [];

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

    // Mis Rutas es una funcion paga: si no hay un plan activo, no se expone el link del mapa
    // (así el dashboard cae en el estado de "Contratar" en vez de mostrar el mapa gratis).
    const hasActiveSubscription = subscriptions.some((s) => s.status === 'activa');
    if (association && !hasActiveSubscription) {
      association = { ...association, routes_kml_url: null };
    }
  }

  res.json({ user, association, subscriptions, payments });
}));

module.exports = router;
