const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/logger');
const { getMassBalanceSummary, getRecicladores } = require('../db/massBalanceQueries');

const router = express.Router();

// GET /mass-balance/summary -> resumen del balance de masas de la asociacion del usuario logueado
router.get('/mass-balance/summary', requireAuth, asyncRoute(async (req, res) => {
  if (!req.user.associationId) {
    return res.status(400).json({ error: 'Tu usuario no tiene una asociación asignada.' });
  }
  const summary = await getMassBalanceSummary(req.user.associationId);
  res.json(summary);
}));

// GET /recicladores -> recicladores de la asociacion del usuario logueado
router.get('/recicladores', requireAuth, asyncRoute(async (req, res) => {
  if (!req.user.associationId) {
    return res.status(400).json({ error: 'Tu usuario no tiene una asociación asignada.' });
  }
  const recicladores = await getRecicladores(req.user.associationId);
  res.json(recicladores);
}));

module.exports = router;
