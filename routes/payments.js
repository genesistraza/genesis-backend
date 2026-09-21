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

function escapeHtml(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// POST /payments/create -> genera los datos para abrir el widget de Wompi en el frontend
router.post('/create', requireAuth, asyncRoute(async (req, res) => {
  const subscriptionId = Number(req.body.subscriptionId);
  if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
    return res.status(400).json({ error: 'Suscripción inválida.' });
  }

  if (!req.user.associationId) {
    return res.status(400).json({ error: 'Tu usuario no tiene una asociación asignada.' });
  }

  // El monto nunca se confia del navegador: se recalcula aqui a partir del plan real de la
  // suscripcion, y se verifica que la suscripcion sea realmente de la asociacion del usuario.
  const subResult = await pool.query(
    `SELECT s.id, s.association_id, s.billing_cycle, p.price_monthly, p.price_annual
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.id = $1`,
    [subscriptionId]
  );
  const sub = subResult.rows[0];
  if (!sub) {
    return res.status(404).json({ error: 'Suscripción no encontrada.' });
  }
  if (sub.association_id !== req.user.associationId) {
    return res.status(403).json({ error: 'No tienes permiso sobre esta suscripción.' });
  }

  // price_annual es la tarifa mensual con descuento por pagar anual, no el total del año:
  // el cobro real es esa tarifa multiplicada por los 12 meses.
  const amount = Math.round(sub.billing_cycle === 'anual' ? Number(sub.price_annual) * 12 : Number(sub.price_monthly));
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'El plan no tiene un precio válido.' });
  }

  const reference = `GT-${subscriptionId}-${Date.now()}`;
  const amountInCents = amount * 100;

  // Firma de integridad exigida por Wompi (evita que alguien manipule el monto desde el navegador)
  const signatureString = `${reference}${amountInCents}COP${process.env.WOMPI_INTEGRITY_SECRET}`;
  const signature = crypto.createHash('sha256').update(signatureString).digest('hex');

  // La referencia queda guardada: el webhook ubica el pago por ella (antes lo hacia por el monto,
  // y dos asociaciones con el mismo plan podian quedar cruzadas: pagaba una y se activaba la otra).
  await pool.query(
    `INSERT INTO payments (subscription_id, amount, status, reference) VALUES ($1,$2,'pendiente',$3)`,
    [subscriptionId, amount, reference]
  );

  res.json({
    publicKey: process.env.WOMPI_PUBLIC_KEY,
    currency: 'COP',
    amountInCents,
    reference,
    signature
  });
}));

function checksumMatches(expected, received) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(received || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST /payments/webhook -> Wompi llama aquí cuando el pago se aprueba o rechaza
router.post('/webhook', express.json(), asyncRoute(async (req, res) => {
  const event = req.body || {};

  // Verificación de firma del evento (Wompi la envía en event.signature)
  const sig = event.signature;
  if (!sig || !Array.isArray(sig.properties) || !sig.checksum || !event.timestamp) {
    return res.status(400).json({ error: 'Evento sin firma.' });
  }
  // Segun la documentacion de Wompi, las rutas de "signature.properties" (p. ej. transaction.id) son
  // relativas a event.data, no a la raiz del evento (el codigo anterior las resolvia desde la raiz y
  // fallaba con cada evento real).
  let concatenated;
  try {
    concatenated = sig.properties.map((p) => p.split('.').reduce((obj, key) => obj[key], event.data)).join('');
  } catch (e) {
    return res.status(400).json({ error: 'Evento mal formado.' });
  }
  const checksum = crypto
    .createHash('sha256')
    .update(concatenated + event.timestamp + process.env.WOMPI_EVENTS_SECRET)
    .digest('hex');
  if (!checksumMatches(checksum, sig.checksum)) {
    return res.status(400).json({ error: 'Firma de Wompi inválida.' });
  }

  // Solo interesan los cambios de una transaccion; cualquier otro evento se acusa y se ignora.
  const transaction = event.data && event.data.transaction;
  if (event.event !== 'transaction.updated' || !transaction || !transaction.reference) {
    return res.sendStatus(200);
  }

  // PENDING no es un resultado: no se marca nada (antes cualquier estado distinto de APPROVED
  // quedaba como "rechazado").
  const status = transaction.status === 'APPROVED' ? 'aprobado'
    : ['DECLINED', 'ERROR', 'VOIDED'].includes(transaction.status) ? 'rechazado' : null;
  if (!status) return res.sendStatus(200);

  const payResult = await pool.query(
    'SELECT id, subscription_id, amount, status FROM payments WHERE reference = $1',
    [transaction.reference]
  );
  const payment = payResult.rows[0];
  if (!payment) {
    await logActivity(null, 'webhook_wompi_sin_pago', { reference: transaction.reference, transactionId: transaction.id });
    return res.sendStatus(200);
  }
  // Wompi reintenta los webhooks: si ya se proceso como aprobado no se repite nada (ni el correo).
  if (payment.status === 'aprobado') return res.sendStatus(200);

  // El monto que Wompi cobró tiene que ser exactamente el del plan.
  if (status === 'aprobado' && Number(transaction.amount_in_cents) !== Number(payment.amount) * 100) {
    await logActivity(null, 'webhook_wompi_monto_distinto', {
      reference: transaction.reference, esperado: Number(payment.amount) * 100, recibido: transaction.amount_in_cents
    });
    return res.sendStatus(200);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE payments SET status = $1, wompi_transaction_id = $2, payment_method = $3,
         paid_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END
       WHERE id = $4`,
      [status, transaction.id, transaction.payment_method_type, payment.id, status === 'aprobado']
    );
    if (status === 'aprobado') {
      const subRow = await client.query(
        'SELECT id, association_id, billing_cycle FROM subscriptions WHERE id = $1',
        [payment.subscription_id]
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
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // El correo de aviso nunca debe hacer fallar el webhook: el pago ya quedo registrado.
  if (status === 'aprobado') {
    try {
      const detail = await pool.query(
        `SELECT a.name AS association_name, a.nit, p.name AS plan_name, pay.amount, u.full_name, u.email, u.phone
         FROM payments pay
         JOIN subscriptions s ON s.id = pay.subscription_id
         JOIN associations a ON a.id = s.association_id
         JOIN plans p ON p.id = s.plan_id
         LEFT JOIN users u ON u.association_id = a.id AND u.role = 'operativo'
         WHERE pay.id = $1
         LIMIT 1`,
        [payment.id]
      );
      const d = detail.rows[0];
      if (d) {
        const settings = await pool.query('SELECT email FROM notification_settings WHERE id = 1');
        const notifyEmail = settings.rows[0]?.email || 'genesistraza@gmail.com';
        await resend.emails.send({
          from: process.env.EMAIL_FROM || 'Genesis Traza <no-reply@genesistraza.com>',
          to: notifyEmail,
          subject: `Nuevo pago aprobado: ${d.association_name} - ${gtFormatCOP(d.amount)}`,
          html: `<p>Se aprobó un pago en Genesis Traza.</p>
                 <ul>
                   <li><strong>Asociación:</strong> ${escapeHtml(d.association_name)} (NIT: ${escapeHtml(d.nit || '—')})</li>
                   <li><strong>Plan:</strong> ${escapeHtml(d.plan_name)}</li>
                   <li><strong>Monto:</strong> ${gtFormatCOP(d.amount)}</li>
                   <li><strong>Contacto:</strong> ${escapeHtml(d.full_name || '—')} — ${escapeHtml(d.email || '—')} — ${escapeHtml(d.phone || '—')}</li>
                   <li><strong>Método:</strong> ${escapeHtml(transaction.payment_method_type)}</li>
                   <li><strong>ID de transacción:</strong> ${escapeHtml(transaction.id)}</li>
                 </ul>`
        });
      }
    } catch (e) {
      console.error('No se pudo enviar el aviso de pago aprobado:', e.message);
    }
  }

  await logActivity(null, 'webhook_wompi', { status, transactionId: transaction.id, reference: transaction.reference });
  res.sendStatus(200);
}));

module.exports = router;
