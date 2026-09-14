const express = require('express');
const crypto = require('crypto');
const { Resend } = require('resend');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

function gtFormatCOP(value) {
  return '$' + Number(value || 0).toLocaleString('es-CO');
}

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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const subRow = await client.query(
        `SELECT s.id, s.association_id, s.billing_cycle FROM subscriptions s
         JOIN payments pay ON pay.subscription_id = s.id
         WHERE pay.wompi_transaction_id = $1`,
        [transaction.id]
      );
      const sub = subRow.rows[0];
      if (sub) {
        // Una asociación solo puede tener un plan activo: se cancela cualquier otro antes de activar este.
        await client.query(
          `UPDATE subscriptions SET status='cancelada' WHERE association_id = $1 AND status='activa' AND id != $2`,
          [sub.association_id, sub.id]
        );
        const interval = sub.billing_cycle === 'anual' ? '365 days' : '30 days';
        await client.query(
          `UPDATE subscriptions SET status='activa', next_due_date = NOW() + $2::interval WHERE id = $1`,
          [sub.id, interval]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const detail = await pool.query(
      `SELECT a.name AS association_name, a.nit, p.name AS plan_name, pay.amount, u.full_name, u.email, u.phone
       FROM payments pay
       JOIN subscriptions s ON s.id = pay.subscription_id
       JOIN associations a ON a.id = s.association_id
       JOIN plans p ON p.id = s.plan_id
       LEFT JOIN users u ON u.association_id = a.id AND u.role = 'operativo'
       WHERE pay.wompi_transaction_id = $1
       LIMIT 1`,
      [transaction.id]
    );
    const d = detail.rows[0];
    if (d) {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'Genesis Traza <no-reply@genesistraza.com>',
        to: 'genesistraza@gmail.com',
        subject: `Nuevo pago aprobado: ${d.association_name} - ${gtFormatCOP(d.amount)}`,
        html: `<p>Se aprobó un pago en Genesis Traza.</p>
               <ul>
                 <li><strong>Asociación:</strong> ${d.association_name} (NIT: ${d.nit || '—'})</li>
                 <li><strong>Plan:</strong> ${d.plan_name}</li>
                 <li><strong>Monto:</strong> ${gtFormatCOP(d.amount)}</li>
                 <li><strong>Contacto:</strong> ${d.full_name || '—'} — ${d.email || '—'} — ${d.phone || '—'}</li>
                 <li><strong>Método:</strong> ${transaction.payment_method_type}</li>
                 <li><strong>ID de transacción:</strong> ${transaction.id}</li>
               </ul>`
      });
    }
  }

  await logActivity(null, 'webhook_wompi', { status, transactionId: transaction.id });
  res.sendStatus(200);
}));

module.exports = router;
