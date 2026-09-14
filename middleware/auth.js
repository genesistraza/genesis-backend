const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Debes iniciar sesión.' });
  }
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada.' });
  }
}

// role: 'pro' ve y controla todo. 'admin' es operativo. 'operativo' es el usuario normal de asociación.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No tienes permisos para esta acción.' });
    }
    next();
  };
}

// Exige que la asociacion del usuario tenga un plan realmente activo (pagado), para que
// funciones de pago (balance de masas, recicladores, etc.) no queden accesibles sin pagar.
// Los roles pro/admin nunca pasan por aqui: ven cualquier asociacion desde sus propias rutas.
async function requireActiveSubscription(req, res, next) {
  if (!req.user.associationId) {
    return res.status(403).json({ error: 'Tu usuario no tiene una asociación asignada.' });
  }
  const result = await pool.query(
    `SELECT 1 FROM subscriptions WHERE association_id = $1 AND status = 'activa' LIMIT 1`,
    [req.user.associationId]
  );
  if (result.rows.length === 0) {
    return res.status(402).json({ error: 'Necesitas un plan activo para acceder a esta función.' });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireActiveSubscription };
