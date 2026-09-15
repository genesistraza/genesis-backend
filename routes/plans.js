const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();

// El precio anual nunca se digita a mano: se calcula solo a partir del mensual, regalando
// 1 mes (11 meses de tarifa por los 12 del año). Este valor queda guardado como la tarifa
// MENSUAL con ese descuento (lo que se muestra como "/mes" al elegir facturación anual);
// el total que se cobra por el año es este valor multiplicado por 12 (round(mensual*11/12)*12
// = mensual*11 redondeado, es decir, 11 meses exactos).
function computeAnnualRate(priceMonthly) {
  return Math.round((Number(priceMonthly) * 11) / 12);
}

// GET /plans -> pública, la usa la landing para pintar los precios
router.get('/', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM plans WHERE active = true ORDER BY category, price_monthly');
  res.json(result.rows);
}));

// GET /plans/all -> todos los planes, activos e inactivos (solo 'pro'). La usa el panel de
// administración para poder ver y reactivar un plan que se desactivó por error - la publica
// de arriba nunca los muestra, así que sin esta ruta un plan desactivado quedaba "perdido".
router.get('/all', requireAuth, requireRole('pro'), asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM plans ORDER BY active DESC, category, price_monthly');
  res.json(result.rows);
}));

// POST /plans -> crear plan nuevo (solo rol 'pro')
router.post('/', requireAuth, requireRole('pro'), asyncRoute(async (req, res) => {
  const { category, name, price_monthly, description, features, is_featured } = req.body;
  const priceAnnual = computeAnnualRate(price_monthly);
  const result = await pool.query(
    `INSERT INTO plans (category, name, price_monthly, price_annual, description, features, is_featured)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [category, name, price_monthly, priceAnnual, description, JSON.stringify(features || []), !!is_featured]
  );
  await logActivity(req.user.id, 'plan_creado', { plan: result.rows[0] });
  res.json(result.rows[0]);
}));

// PUT /plans/:id -> editar plan existente (solo rol 'pro')
router.put('/:id', requireAuth, requireRole('pro'), asyncRoute(async (req, res) => {
  const { category, name, price_monthly, description, features, is_featured, active } = req.body;
  const priceAnnual = computeAnnualRate(price_monthly);
  let result;
  try {
    result = await pool.query(
      `UPDATE plans SET category=$1, name=$2, price_monthly=$3, price_annual=$4,
       description=$5, features=$6, is_featured=$7, active=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [category, name, price_monthly, priceAnnual, description, JSON.stringify(features || []), !!is_featured, active !== false, req.params.id]
    );
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ya hay otro plan activo con ese mismo nombre y categoría.' });
    }
    throw err;
  }
  await logActivity(req.user.id, 'plan_editado', { planId: req.params.id });
  res.json(result.rows[0]);
}));

// DELETE /plans/:id -> desactivar plan (no se borra, solo se oculta)
router.delete('/:id', requireAuth, requireRole('pro'), asyncRoute(async (req, res) => {
  await pool.query('UPDATE plans SET active = false WHERE id = $1', [req.params.id]);
  await logActivity(req.user.id, 'plan_desactivado', { planId: req.params.id });
  res.json({ message: 'Plan desactivado.' });
}));

module.exports = router;
