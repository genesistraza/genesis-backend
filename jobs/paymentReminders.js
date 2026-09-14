const cron = require('node-cron');
const { Resend } = require('resend');
const pool = require('../db/pool');
const { buildPaymentReminderEmail } = require('../utils/emailTemplate');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendReminderBatch(dateCondition, subject, extraNoteFor) {
  const rows = await pool.query(`
    SELECT s.id, a.name AS association_name, u.email, u.full_name, p.name AS plan_name, s.next_due_date
    FROM subscriptions s
    JOIN associations a ON a.id = s.association_id
    JOIN users u ON u.association_id = a.id AND u.role = 'operativo'
    JOIN plans p ON p.id = s.plan_id
    WHERE s.status = 'activa' AND ${dateCondition}
  `);

  for (const row of rows.rows) {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Genesis Traza <no-reply@genesistraza.com>',
      to: row.email,
      subject,
      html: buildPaymentReminderEmail({
        fullName: row.full_name,
        associationName: row.association_name,
        planName: row.plan_name,
        nextDueDate: row.next_due_date,
        extraNote: extraNoteFor(row)
      })
    });
  }
  return rows.rows.length;
}

// Corre todos los días a las 8:00 AM (hora del servidor)
function startPaymentReminders() {
  cron.schedule('0 8 * * *', async () => {
    console.log('Revisando pagos próximos a vencer...');

    const sent5Days = await sendReminderBatch(
      `s.next_due_date::date = (NOW() + INTERVAL '5 days')::date`,
      'Tu pago con Genesis Traza vence en 5 días',
      () => 'Te escribimos para recordarte que tu plan vence en 5 días.'
    );

    const sentToday = await sendReminderBatch(
      `s.next_due_date::date = NOW()::date`,
      'Tu pago con Genesis Traza vence hoy',
      () => 'Te escribimos para recordarte que tu plan vence hoy. Renueva hoy mismo para no perder el acceso al servicio.'
    );

    // Marca como vencidas las suscripciones que ya pasaron su fecha (despues de mandar el recordatorio del dia)
    await pool.query(
      `UPDATE subscriptions SET status = 'vencida' WHERE next_due_date < NOW() AND status = 'activa'`
    );

    console.log(`Recordatorios enviados: ${sent5Days} (5 días antes), ${sentToday} (día del vencimiento).`);
  });
}

module.exports = startPaymentReminders;
