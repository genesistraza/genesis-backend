// Plantilla compartida para los correos transaccionales (recordatorios de pago, códigos,
// notificaciones). Centralizada aquí para que todos los correos que le llegan al cliente
// se vean iguales y con la marca, en vez de texto plano suelto en cada archivo.

const SITE_URL = process.env.SITE_URL || 'https://genesistraza.com';
const ROBOT_IMG_URL = SITE_URL + '/robot-email.png';
const LOGIN_URL = SITE_URL + '/?login=1';

function formatDateEs(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
}

function buildEmailHtml({ heading, bodyHtml, ctaText, ctaUrl }) {
  return `<!DOCTYPE html>
  <html lang="es">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
  <body style="margin:0;padding:0;">
  <div style="background:#F4F7FC;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E4E9F2;">
      <tr>
        <td style="background:#0A3369;padding:22px 24px;text-align:center;">
          <img src="${ROBOT_IMG_URL}" alt="Genesis Traza" width="76" style="display:block;margin:0 auto 8px;border:0;">
          <div style="color:#ffffff;font-weight:700;font-size:18px;letter-spacing:.2px;">Genesis Traza</div>
        </td>
      </tr>
      <tr>
        <td style="padding:28px 28px 8px;">
          <h1 style="margin:0 0 14px;font-size:19px;color:#0F1B2D;">${heading}</h1>
          <div style="font-size:14.5px;line-height:1.65;color:#4B5A6E;">${bodyHtml}</div>
        </td>
      </tr>
      ${ctaUrl ? `
      <tr>
        <td style="padding:8px 28px 30px;text-align:center;">
          <a href="${ctaUrl}" style="display:inline-block;background:#F2941F;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 34px;border-radius:10px;">${ctaText || 'Ingresar'}</a>
        </td>
      </tr>` : '<tr><td style="padding-bottom:12px;"></td></tr>'}
      <tr>
        <td style="padding:16px 28px;background:#F4F7FC;text-align:center;font-size:12px;color:#8291A3;">
          Genesis Traza — Trazabilidad y facturación para asociaciones de reciclaje<br>
          <a href="${SITE_URL}" style="color:#8291A3;">genesistraza.com</a>
        </td>
      </tr>
    </table>
  </div>
  </body>
  </html>`;
}

// Correo de recordatorio de pago (usado tanto por el envio manual desde el panel como por el
// job automatico). "extraNote" es la unica parte que cambia entre variantes (5 dias antes / hoy).
function buildPaymentReminderEmail({ fullName, associationName, planName, nextDueDate, extraNote }) {
  const dueDateText = formatDateEs(nextDueDate);
  const infoRows = [
    { label: 'Asociación', value: associationName },
    planName ? { label: 'Plan', value: planName } : null,
    dueDateText ? { label: 'Vence', value: dueDateText } : null
  ].filter(Boolean);

  const infoBox = `
    <div style="background:#EAF3FC;border-radius:10px;padding:14px 18px;margin:16px 0;">
      ${infoRows.map((row, i) => `
        <div style="font-size:12.5px;color:#4B5A6E;${i > 0 ? 'margin-top:10px;' : ''}">${row.label}</div>
        <div style="font-weight:700;color:#0A3369;font-size:15px;">${row.value}</div>
      `).join('')}
    </div>`;

  const bodyHtml = `
    <p>Hola ${fullName},</p>
    <p>${extraNote}</p>
    ${infoBox}
    <p>Ingresa a tu cuenta para ponerte al día y evitar la suspensión del servicio.</p>
  `;

  return buildEmailHtml({
    heading: 'Recordatorio de pago',
    bodyHtml,
    ctaText: 'Iniciar sesión',
    ctaUrl: LOGIN_URL
  });
}

module.exports = { buildEmailHtml, buildPaymentReminderEmail, formatDateEs, SITE_URL, LOGIN_URL, ROBOT_IMG_URL };
