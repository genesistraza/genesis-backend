const express = require('express');
const { requireAuth, requireActiveSubscription } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/logger');
const { getMassBalanceSummary, getMassBalancePeriods, getRecicladores } = require('../db/massBalanceQueries');

const router = express.Router();

// GET /mass-balance/summary -> resumen del balance de masas de la asociacion del usuario logueado.
// Requiere un plan activo: son datos de un servicio pago, no se pueden ver sin haber pagado.
// Acepta ?period=year|month|week&value=... para acotar a un periodo especifico.
router.get('/mass-balance/summary', requireAuth, requireActiveSubscription, asyncRoute(async (req, res) => {
  const summary = await getMassBalanceSummary(req.user.associationId, req.query.period, req.query.value);
  res.json(summary);
}));

// GET /mass-balance/periods -> años, meses y semanas con datos, para poblar los filtros
router.get('/mass-balance/periods', requireAuth, requireActiveSubscription, asyncRoute(async (req, res) => {
  const periods = await getMassBalancePeriods(req.user.associationId);
  res.json(periods);
}));

// GET /recicladores -> recicladores de la asociacion del usuario logueado (requiere plan activo)
router.get('/recicladores', requireAuth, requireActiveSubscription, asyncRoute(async (req, res) => {
  const recicladores = await getRecicladores(req.user.associationId);
  res.json(recicladores);
}));

module.exports = router;
