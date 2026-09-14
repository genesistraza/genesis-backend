const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();

// GET /plans -> pública, la usa la landing para pintar los precios
router.get('/', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM plans WHERE active = true ORDER BY category, price_monthly');
  res.json(result.rows);
}));

// POST /plans -> crear plan nuevo (solo rol 'pro')
router.post('/', requireAuth, requireRole('pro'), asyncRoute(async (req, res) => {
  const { category, name, price_monthly, price_annual, description, features, is_featured } = req.body;
  const result = await pool.query(
    `INSERT INTO plans (category, name, price_monthly, price_annual, description, features, is_featured)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [category, name, price_monthly, price_annual, description, JSON.stringify(features || []), !!is_featured]
  );
  await logActivity(req.user.id, 'plan_creado', { plan: result.rows[0] });
  res.json(result.rows[0]);
}));

// PUT /plans/:id -> editar plan existente (solo rol 'pro')
router.put('/:id', requireAuth, requireRole('pro'), asyncRoute(async (req, res) => {
  const { category, name, price_monthly, price_annual, description, features, is_featured, active } = req.body;
  const result = await pool.query(
    `UPDATE plans SET category=$1, name=$2, price_monthly=$3, price_annual=$4,
     description=$5, features=$6, is_featured=$7, active=$8, updated_at=NOW()
     WHERE id=$9 RETURNING *`,
    [category, name, price_monthly, price_annual, description, JSON.stringify(features || []), !!is_featured, active !== false, req.params.id]
  );
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
