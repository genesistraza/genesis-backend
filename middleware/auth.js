const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Cache en memoria de sessions_invalidated_at: evita una consulta a la base de datos en cada
// request autenticado (que son casi todos). 10s de margen es aceptable para algo que solo se
// usa como boton de panico ("cerrar sesion en todos los dispositivos"), no como flujo normal.
let cachedInvalidatedAt = null;
let cachedInvalidatedAtFetchedAt = 0;
const INVALIDATED_AT_CACHE_MS = 10000;

async function getSessionsInvalidatedAt() {
  const now = Date.now();
  if (cachedInvalidatedAtFetchedAt && now - cachedInvalidatedAtFetchedAt < INVALIDATED_AT_CACHE_MS) {
    return cachedInvalidatedAt;
  }
  const result = await pool.query('SELECT sessions_invalidated_at FROM security_settings WHERE id = 1');
  cachedInvalidatedAt = result.rows[0] ? result.rows[0].sessions_invalidated_at : null;
  cachedInvalidatedAtFetchedAt = now;
  return cachedInvalidatedAt;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Debes iniciar sesión.' });
  }
  const token = header.split(' ')[1];
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada.' });
  }
  try {
    const invalidatedAt = await getSessionsInvalidatedAt();
    if (invalidatedAt && payload.iat * 1000 < new Date(invalidatedAt).getTime()) {
      return res.status(401).json({ error: 'Tu sesión se cerró. Inicia sesión de nuevo.' });
    }
  } catch {
    // Si falla la consulta de invalidacion, no se bloquea el login por un problema aparte de infra.
  }
  req.user = payload;
  next();
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
