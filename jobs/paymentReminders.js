const cron = require('node-cron');
const { Resend } = require('resend');
const pool = require('../db/pool');

const resend = new Resend(process.env.RESEND_API_KEY);

// Corre todos los días a las 8:00 AM (hora del servidor)
function startPaymentReminders() {
  cron.schedule('0 8 * * *', async () => {
    console.log('Revisando pagos próximos a vencer...');

    // Marca como vencidas las suscripciones que ya pasaron su fecha
    await pool.query(
      `UPDATE subscriptions SET status = 'vencida' WHERE next_due_date < NOW() AND status = 'activa'`
    );

    // Recordatorio 3 días antes del vencimiento
    const dueSoon = await pool.query(`
      SELECT s.id, a.name AS association_name, u.email, u.full_name, p.name AS plan_name, s.next_due_date
      FROM subscriptions s
      JOIN associations a ON a.id = s.association_id
      JOIN users u ON u.association_id = a.id AND u.role = 'operativo'
      JOIN plans p ON p.id = s.plan_id
      WHERE s.status = 'activa' AND s.next_due_date::date = (NOW() + INTERVAL '3 days')::date
    `);

    for (const row of dueSoon.rows) {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'Genesis Traza <no-reply@genesis-traza.com>',
        to: row.email,
        subject: 'Tu pago con Genesis Traza vence en 3 días',
        html: `<p>Hola ${row.full_name},</p>
               <p>El plan <strong>${row.plan_name}</strong> de <strong>${row.association_name}</strong> vence el ${row.next_due_date}.</p>
               <p>Ingresa a tu cuenta para renovar y evitar la suspensión del servicio.</p>`
      });
    }

    console.log(`Recordatorios enviados: ${dueSoon.rows.length}`);
  });
}

module.exports = startPaymentReminders;
