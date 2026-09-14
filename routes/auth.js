const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const pool = require('../db/pool');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // código de 6 dígitos
}

// POST /auth/register  -> crea usuario + asociación, envía código por correo
router.post('/register', asyncRoute(async (req, res) => {
  const { fullName, email, phone, password, associationName, nit, recyclerCount } = req.body;

  if (!fullName || !email || !password || !associationName) {
    return res.status(400).json({ error: 'Faltan campos obligatorios del formulario.' });
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
  await pool.query('UPDATE users SET is_verified = true WHERE id = $1', [userId]);
  await logActivity(userId, 'correo_verificado', {});
  res.json({ message: 'Correo verificado. Ya puedes iniciar sesión.' });
}));

// POST /auth/login
router.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body;
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

module.exports = router;
