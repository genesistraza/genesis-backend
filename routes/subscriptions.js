const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();

// POST /subscriptions -> crea (o reutiliza) una suscripcion pendiente para la asociacion del usuario
router.post('/', requireAuth, asyncRoute(async (req, res) => {
  const { planId, billingCycle } = req.body;
  const cycle = billingCycle === 'anual' ? 'anual' : 'mensual';

  if (!req.user.associationId) {
    return res.status(400).json({ error: 'Tu usuario no tiene una asociación asignada.' });
  }

  if (!Number.isInteger(Number(planId)) || Number(planId) <= 0) {
    return res.status(400).json({ error: 'Plan inválido.' });
  }
  const planResult = await pool.query('SELECT * FROM plans WHERE id = $1 AND active = true', [planId]);
  const plan = planResult.rows[0];
  if (!plan) {
    return res.status(404).json({ error: 'Plan no encontrado.' });
  }

  // price_annual es la tarifa mensual con descuento por pagar anual, no el total del año:
  // el cobro real es esa tarifa multiplicada por los 12 meses.
  const amount = cycle === 'anual' ? plan.price_annual * 12 : plan.price_monthly;

  const existing = await pool.query(
    `SELECT id FROM subscriptions WHERE association_id = $1 AND plan_id = $2 AND status = 'pendiente'
     ORDER BY created_at DESC LIMIT 1`,
    [req.user.associationId, planId]
  );

  let subscriptionId;
  if (existing.rows.length > 0) {
    subscriptionId = existing.rows[0].id;
    // Se reutiliza la suscripcion pendiente pero con el ciclo que se acaba de elegir: antes se
    // quedaba con el anterior y se cobraba un monto distinto al que la pantalla mostraba.
    await pool.query('UPDATE subscriptions SET billing_cycle = $1 WHERE id = $2', [cycle, subscriptionId]);
  } else {
    const inserted = await pool.query(
      `INSERT INTO subscriptions (association_id, plan_id, status, billing_cycle) VALUES ($1,$2,'pendiente',$3) RETURNING id`,
      [req.user.associationId, planId, cycle]
    );
    subscriptionId = inserted.rows[0].id;
  }

  await logActivity(req.user.id, 'suscripcion_iniciada', { subscriptionId, planId, cycle });
  res.json({ subscriptionId, amount, planName: plan.name, billingCycle: cycle });
}));

module.exports = router;
