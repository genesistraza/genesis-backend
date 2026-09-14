const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();

// POST /payments/create -> genera los datos para abrir el widget de Wompi en el frontend
router.post('/create', requireAuth, asyncRoute(async (req, res) => {
  const { subscriptionId, amount } = req.body;

  const reference = `GT-${subscriptionId}-${Date.now()}`;
  const amountInCents = amount * 100;

  // Firma de integridad exigida por Wompi (evita que alguien manipule el monto desde el navegador)
  const signatureString = `${reference}${amountInCents}COP${process.env.WOMPI_INTEGRITY_SECRET}`;
  const signature = crypto.createHash('sha256').update(signatureString).digest('hex');

  await pool.query(
    `INSERT INTO payments (subscription_id, amount, status) VALUES ($1,$2,'pendiente')`,
    [subscriptionId, amount]
  );

  res.json({
    publicKey: process.env.WOMPI_PUBLIC_KEY,
    currency: 'COP',
    amountInCents,
    reference,
    signature
  });
}));

// POST /payments/webhook -> Wompi llama aquí cuando el pago se aprueba o rechaza
router.post('/webhook', express.json(), asyncRoute(async (req, res) => {
  const event = req.body;

  // Verificación de firma del evento (Wompi la envía en event.signature)
  const props = event.signature?.properties || [];
  const concatenated = props.map(p => p.split('.').reduce((obj, key) => obj[key], event)).join('');
  const checksum = crypto
    .createHash('sha256')
    .update(concatenated + event.timestamp + process.env.WOMPI_EVENTS_SECRET)
    .digest('hex');

  if (checksum !== event.signature?.checksum) {
    return res.status(400).json({ error: 'Firma de Wompi inválida.' });
  }

  const transaction = event.data.transaction;
  const status = transaction.status === 'APPROVED' ? 'aprobado' : 'rechazado';

  await pool.query(
    `UPDATE payments SET status=$1, wompi_transaction_id=$2, payment_method=$3, paid_at=NOW()
     WHERE amount = $4 AND status='pendiente' ORDER BY created_at DESC LIMIT 1`,
    [status, transaction.id, transaction.payment_method_type, transaction.amount_in_cents / 100]
  );

  if (status === 'aprobado') {
    await pool.query(
      `UPDATE subscriptions SET status='activa', next_due_date = NOW() + INTERVAL '30 days'
       WHERE id = (SELECT subscription_id FROM payments WHERE wompi_transaction_id = $1)`,
      [transaction.id]
    );
  }

  await logActivity(null, 'webhook_wompi', { status, transactionId: transaction.id });
  res.sendStatus(200);
}));

module.exports = router;
