const pool = require('../db/pool');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function logActivity(userId, action, details = {}, ip = null) {
  try {
    await pool.query(
      'INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES ($1,$2,$3,$4)',
      [userId, action, details, ip]
    );
  } catch (err) {
    console.error('No se pudo guardar el log de actividad:', err.message);
  }
}

// Evita inundar el correo si hay muchos errores seguidos (p.ej. una caída de la base de datos):
// como mucho una alerta cada 10 minutos, sin importar cuántos errores ocurran mientras tanto.
let lastErrorEmailAt = 0;
const ERROR_EMAIL_COOLDOWN_MS = 10 * 60 * 1000;

async function alertError(message, route) {
  const now = Date.now();
  if (now - lastErrorEmailAt < ERROR_EMAIL_COOLDOWN_MS) return;
  lastErrorEmailAt = now;
  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Genesis Traza <no-reply@genesistraza.com>',
      to: 'genesistraza@gmail.com',
      subject: 'Error en Genesis Traza: ' + route,
      html: `<p>Ocurrió un error en producción.</p>
             <p><strong>Ruta:</strong> ${route}</p>
             <p><strong>Mensaje:</strong> ${message}</p>
             <p style="color:#888;font-size:12px;">Revisa el detalle completo en el panel de administración, pestaña "Logs de errores". Este aviso no se repite antes de 10 minutos aunque sigan ocurriendo errores.</p>`
    });
  } catch (err) {
    console.error('No se pudo enviar la alerta de error por correo:', err.message);
  }
}

async function logError(message, stack = '', route = '') {
  try {
    await pool.query(
      'INSERT INTO error_logs (message, stack, route) VALUES ($1,$2,$3)',
      [message, stack, route]
    );
  } catch (err) {
    console.error('No se pudo guardar el log de error:', err.message);
  }
  alertError(message, route).catch(() => {});
}

// Middleware que envuelve cualquier ruta y captura errores automáticamente
function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(async (err) => {
      await logError(err.message, err.stack, req.originalUrl);
      res.status(500).json({ error: 'Ocurrió un error interno. Ya quedó registrado en los logs.' });
    });
  };
}

module.exports = { logActivity, logError, asyncRoute };
