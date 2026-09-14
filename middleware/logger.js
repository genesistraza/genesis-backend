const pool = require('../db/pool');

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

async function logError(message, stack = '', route = '') {
  try {
    await pool.query(
      'INSERT INTO error_logs (message, stack, route) VALUES ($1,$2,$3)',
      [message, stack, route]
    );
  } catch (err) {
    console.error('No se pudo guardar el log de error:', err.message);
  }
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
