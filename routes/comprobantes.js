// Comprobantes de Balance de Masas (Pruebas): cada impresion crea un registro INMUTABLE (esta
// ruta nunca tiene PUT ni DELETE) con una "foto" de los datos guardados en ese momento, un token
// de 256 bits imposible de adivinar, y un QR que apunta a una pagina PUBLICA (sin iniciar sesion)
// donde cualquiera puede ver ese mismo comprobante desde cualquier dispositivo. La seguridad no
// esta en el QR en si (es un estandar abierto, cualquiera puede leerlo) sino en que: (1) los datos
// viven en el servidor, no en el codigo QR, asi que alterar el papel impreso no cambia lo que se ve
// al escanear; (2) el token es tan largo que adivinar uno ajeno es inviable; (3) el registro nunca
// se puede editar despues de creado.
const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');
const huella = require('../utils/huella');

const router = express.Router();

function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtNum(n, d = 2) { return Number(n || 0).toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtMoney(n) { return '$ ' + Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 2 }); }
function initials(name) {
  const words = String(name || '').replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 || /^\d/.test(w));
  return ((words.length ? words : [String(name || '?')]).slice(0, 2).map((w) => w.charAt(0)).join('') || '?').toUpperCase();
}

// Clave para el codigo corto de verificacion que se ve a simple vista (sin escanear nada), con
// separacion de dominio del JWT_SECRET para no reutilizar la misma clave con dos propositos.
const CODE_SECRET = (process.env.JWT_SECRET || 'dev-secret') + '|comprobantes-v1';
function codigoVerificacion(token, snapshot) {
  const hex = crypto.createHmac('sha256', CODE_SECRET).update(token + JSON.stringify(snapshot)).digest('hex').slice(0, 8).toUpperCase();
  return hex.slice(0, 4) + '-' + hex.slice(4);
}

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://genesistraza.com').replace(/\/$/, '');
const FORMATOS = ['carta', 'media_carta', 'carta_horizontal', 'tirilla'];

// POST /comprobantes -> crea un comprobante a partir de lo que YA esta guardado en la base de
// datos (nunca de lo que el navegador diga que hay en pantalla), para que el papel impreso y el
// QR siempre muestren exactamente la misma fuente de verdad. Solo 'pro' (mismo candado que /trazabilidad).
router.post('/', requireAuth, requireRole('pro'), asyncRoute(async (req, res) => {
  const idReciclador = Number(req.body.id_reciclador);
  const fecha = String(req.body.fecha || '');
  const formato = FORMATOS.includes(req.body.formato) ? req.body.formato : 'carta';
  if (!Number.isInteger(idReciclador) || idReciclador <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return res.status(400).json({ error: 'Falta el reciclador o la fecha.' });
  }

  const recRes = await pool.query(
    `SELECT r.id, r.id_centro, r.nombre_completo, r.nro_documento, r.tipo_de_vehiculo, r.placa,
            c.desc_centro, c.nit, c.direccion, c.telefono, c.correo
     FROM tz_recicladores r JOIN tz_centros c ON c.id = r.id_centro WHERE r.id = $1`,
    [idReciclador]
  );
  if (recRes.rows.length === 0) return res.status(404).json({ error: 'Reciclador no encontrado.' });
  const rec = recRes.rows[0];

  const rowsRes = await pool.query(
    `SELECT bm.cantidad, bm.valor, bm.cantidad_rechazo, bm.cantidad_nosui,
            bm.id_bodega, bm.id_macrorruta, bm.id_microrruta_1, bm.id_microrruta_2,
            tm.desc_tipo_material
     FROM tz_formulario_balance_masas bm
     LEFT JOIN tz_tipos_material tm ON tm.id = bm.id_tipo_material
     WHERE bm.id_reciclador = $1 AND bm.fecha = $2
     ORDER BY tm.secuencia_orden`,
    [idReciclador, fecha]
  );
  if (rowsRes.rows.length === 0) {
    return res.status(404).json({ error: 'No hay balance de masas guardado ese día para ese reciclador. Guarda primero y luego imprime.' });
  }

  const first = rowsRes.rows[0];
  const [bodega, macro, micro1, micro2] = await Promise.all([
    first.id_bodega ? pool.query('SELECT cod_bodega, desc_bodega FROM tz_bodegas WHERE id=$1', [first.id_bodega]) : Promise.resolve(null),
    first.id_macrorruta ? pool.query('SELECT cod_macrorruta, desc_macrorruta FROM tz_macrorrutas WHERE id=$1', [first.id_macrorruta]) : Promise.resolve(null),
    first.id_microrruta_1 ? pool.query('SELECT desc_microrruta FROM tz_formulario_microrrutas_detalle WHERE id=$1', [first.id_microrruta_1]) : Promise.resolve(null),
    first.id_microrruta_2 ? pool.query('SELECT desc_microrruta FROM tz_formulario_microrrutas_detalle WHERE id=$1', [first.id_microrruta_2]) : Promise.resolve(null)
  ]);
  const combo = (a, b) => [a, b].filter(Boolean).join(' - ') || null;

  const rows = rowsRes.rows.map((r) => {
    const cantidad = Number(r.cantidad), valor = Number(r.valor);
    return { material: r.desc_tipo_material || 'Material', cantidad, valor, valorTotal: cantidad * valor, rechazo: Number(r.cantidad_rechazo), nosui: Number(r.cantidad_nosui) };
  });
  const totales = rows.reduce((t, r) => ({
    cantidad: t.cantidad + r.cantidad, valorTotal: t.valorTotal + r.valorTotal, rechazo: t.rechazo + r.rechazo, nosui: t.nosui + r.nosui
  }), { cantidad: 0, valorTotal: 0, rechazo: 0, nosui: 0 });

  const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const [y, m, d] = fecha.split('-').map(Number);
  const diaSemana = dias[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];

  const logoRes = await pool.query(
    `SELECT logo_url FROM associations
     WHERE logo_url IS NOT NULL AND left(regexp_replace(COALESCE(nit,''), '\\D', '', 'g'), 9) = left(regexp_replace(COALESCE($1,''), '\\D', '', 'g'), 9)
     LIMIT 1`,
    [rec.nit]
  );

  const token = crypto.randomBytes(32).toString('hex'); // 256 bits: no se puede adivinar por fuerza bruta
  const numero = 'BM-' + fecha.replace(/-/g, '') + '-' + String(idReciclador).padStart(4, '0') + '-' + token.slice(0, 6).toUpperCase();

  const snapshot = {
    numero, fecha, diaSemana, formato,
    centro: { nombre: rec.desc_centro, nit: rec.nit, direccion: rec.direccion, telefono: rec.telefono, correo: rec.correo, logoUrl: logoRes.rows[0] ? logoRes.rows[0].logo_url : null },
    reciclador: { nombre: rec.nombre_completo, documento: rec.nro_documento, vehiculo: rec.tipo_de_vehiculo, placa: rec.placa },
    operacion: {
      eca: bodega && bodega.rows[0] ? combo(bodega.rows[0].cod_bodega, bodega.rows[0].desc_bodega) : null,
      macrorruta: macro && macro.rows[0] ? combo(macro.rows[0].cod_macrorruta, macro.rows[0].desc_macrorruta) : null,
      micro1: micro1 && micro1.rows[0] ? micro1.rows[0].desc_microrruta : null,
      micro2: micro2 && micro2.rows[0] ? micro2.rows[0].desc_microrruta : null
    },
    rows, totales
  };
  // Reimprimir el mismo dia sin que haya cambiado nada devuelve EL MISMO comprobante (mismo numero,
  // QR y huella): solo se crea uno nuevo si los datos son distintos. El formato de papel (carta,
  // tirilla...) y el logo no cuentan como cambio de datos.
  const datosDe = (s) => huella.canonico({ centro: { ...s.centro, logoUrl: null }, reciclador: s.reciclador, operacion: s.operacion, rows: s.rows, totales: s.totales });
  const previo = (await pool.query(
    'SELECT token, numero, snapshot, codigo_verificacion FROM tz_comprobantes WHERE id_reciclador = $1 AND fecha = $2 ORDER BY id DESC LIMIT 1',
    [idReciclador, fecha])).rows[0];
  if (previo && datosDe(previo.snapshot) === datosDe(JSON.parse(JSON.stringify(snapshot)))) {
    const url = `${PUBLIC_BASE}/comprobantes/${previo.token}`;
    const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'H', margin: 1, width: 320 });
    return res.json({ token: previo.token, numero: previo.numero, codigoVerificacion: previo.codigo_verificacion, url, qrDataUrl,
      snapshot: { ...previo.snapshot, formato }, reutilizado: true, selloDia: `GT${rec.id_centro}-${fecha.replace(/-/g, '')}` });
  }

  const codigo = codigoVerificacion(token, snapshot);

  // El comprobante y su huella se guardan juntos: si el sellado falla, no queda comprobante sin sellar.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO tz_comprobantes (token, numero, id_centro, id_reciclador, fecha, formato, snapshot, codigo_verificacion, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, numero, fecha, id_centro, id_reciclador, snapshot`,
      [token, numero, rec.id_centro, idReciclador, fecha, formato, snapshot, codigo, req.user.id]
    );
    const c = ins.rows[0];
    await huella.sellar(client, { tipo: 'comprobante', version: 'comprobante-v1', refId: c.id, idCentro: c.id_centro, registro: c });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await logActivity(req.user.id, 'pruebas_comprobante_generado', { id_reciclador: idReciclador, fecha, formato, numero }, req.ip);

  const url = `${PUBLIC_BASE}/comprobantes/${token}`;
  const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'H', margin: 1, width: 320 });

  res.json({ token, numero, codigoVerificacion: codigo, url, qrDataUrl, snapshot, selloDia: `GT${rec.id_centro}-${fecha.replace(/-/g, '')}` });
}));

// Bloque de integridad de la pagina publica: resultado de cada comprobacion de la cadena.
function renderIntegridad(v, token) {
  if (!v || !v.sellado) return '<div class="card integ"><h3>Integridad</h3><p class="muted">Este comprobante es anterior a la cadena de integridad y aún no tiene huella.</p></div>';
  const fila = (ok, titulo, detalle) => `<div class="chk ${ok === true ? 'ok' : ok === false ? 'bad' : 'wait'}"><span class="dot">${ok === true ? '✓' : ok === false ? '✕' : '…'}</span><div><b>${titulo}</b><small>${detalle}</small></div></div>`;
  const s = v.selloDia;
  const anclaje = !s ? fila(null, 'Anclaje en Bitcoin', `Se ancla en la madrugada siguiente al ${esc(v.fechaSello)}.`)
    : s.estado === 'confirmado' ? fila(true, 'Anclado en Bitcoin', `Bloque ${esc(s.bloque)} · sello del ${esc(s.fecha)}.`)
    : fila(null, 'Anclaje en Bitcoin', s.estado === 'error' ? 'Reintentando el envío a OpenTimestamps.' : 'Enviado a OpenTimestamps; Bitcoin lo confirma en unas horas.');
  return `<div class="card integ"><h3>Integridad del documento</h3>
  ${fila(v.integro, v.integro ? 'Contenido íntegro' : 'Contenido alterado', v.integro ? 'Coincide exactamente con la huella registrada al emitirlo.' : 'Los datos no coinciden con la huella registrada.')}
  ${fila(v.cadena, v.cadena ? 'Cadena válida' : 'Cadena rota', v.cadena ? 'Encadenado sin cortes con los registros de su asociación.' : 'La cadena de huellas de la asociación no cuadra.')}
  ${s ? fila(v.enRaiz, v.enRaiz ? 'Incluido en el sello del día' : 'No coincide con el sello del día', `Sello del ${esc(s.fecha)}.`) : ''}
  ${anclaje}
  <div class="hash">Huella: <code>${esc(v.huella)}</code></div>
  <div class="links"><a href="/verificar.html?q=${esc(v.rec)}">Ver la trazabilidad de ${esc(v.rec)}</a> · <a href="/comprobantes/${esc(token)}/prueba.json">Descargar prueba</a>${s && s.tieneOts ? ` · <a href="/comprobantes/sellos/${esc(s.fecha)}/sello.txt">Sello del día (.txt)</a> · <a href="/comprobantes/sellos/${esc(s.fecha)}/sello.ots">Prueba OpenTimestamps (.ots)</a>` : ''}</div>
  </div>`;
}

function renderPublicPage(s, codigo, createdAt, v, token) {
  const org = s.centro.nombre || 'Asociación';
  const logo = s.centro.logoUrl
    ? `<img class="logo" src="${esc(s.centro.logoUrl)}" alt="">`
    : `<div class="logo mono">${esc(initials(org))}</div>`;
  const contacto = [s.centro.direccion, s.centro.telefono, s.centro.correo].filter(Boolean).map(esc).join(' · ');
  const rowsHtml = s.rows.map((r) => `<tr>
      <td class="l" data-label="Material">${esc(r.material)}</td>
      <td data-label="Cantidad (kg)">${fmtNum(r.cantidad)}</td>
      <td data-label="Valor/kg">${r.valor ? fmtMoney(r.valor) : '—'}</td>
      <td class="b" data-label="Total">${r.valorTotal ? fmtMoney(r.valorTotal) : '—'}</td>
      <td data-label="Rechazo (kg)">${r.rechazo ? fmtNum(r.rechazo) : '—'}</td>
      <td data-label="No SUI (kg)">${r.nosui ? fmtNum(r.nosui) : '—'}</td>
    </tr>`).join('');
  const generado = new Date(createdAt).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'long', timeStyle: 'short' });

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comprobante ${esc(s.numero)} — Genesis Traza</title>
<style>
:root{ --blue:#0A3369; --orange:#F2941F; --line:#DCE3EA; --soft:#5B6B7C; }
*{ box-sizing:border-box; }
body{ font-family:"Segoe UI",Arial,Helvetica,sans-serif; margin:0; background:#F4F7FC; color:#1B2733; -webkit-text-size-adjust:100%; }
.wrap{ max-width:640px; margin:0 auto; padding:16px 14px 40px; }
.verified{ display:flex; align-items:center; gap:8px; background:#E7F6EC; color:#1E7E42; border:1px solid #BFE6CC; border-radius:10px; padding:10px 14px; font-size:13px; font-weight:600; margin-bottom:14px; }
.verified svg{ flex:none; }
.card{ background:#fff; border:1px solid var(--line); border-radius:14px; padding:18px; margin-bottom:14px; }
.top{ display:flex; align-items:center; gap:14px; padding-bottom:14px; border-bottom:3px solid var(--orange); margin-bottom:14px; flex-wrap:wrap; }
.logo{ width:56px; height:56px; object-fit:contain; border-radius:10px; flex:none; }
.logo.mono{ display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg,var(--blue),#1a57a8); color:#fff; font-weight:800; font-size:19px; }
.top h2{ margin:0 0 2px; font-size:16px; color:var(--blue); }
.top .nit, .top .contact{ font-size:11.5px; color:var(--soft); }
h1{ font-size:19px; margin:0 0 4px; color:var(--blue); font-family:Georgia,"Times New Roman",serif; font-weight:600; }
.ref{ font-size:12px; color:var(--soft); }
.kv{ display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; font-size:13px; margin-top:14px; }
.kv div b{ display:block; font-size:10px; color:var(--soft); font-weight:600; text-transform:uppercase; letter-spacing:.4px; margin-bottom:2px; }
table{ width:100%; border-collapse:collapse; font-size:13px; }
th{ background:var(--blue); color:#fff; padding:7px 8px; text-align:right; font-size:10.5px; }
th.l, td.l{ text-align:left; }
td{ padding:6px 8px; border-bottom:1px solid var(--line); text-align:right; }
tfoot td{ font-weight:700; border-top:2px solid var(--blue); background:#EEF3FA; }
.kpis{ display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:12px; }
.kpi{ border:1px solid var(--line); border-radius:10px; padding:8px 10px; }
.kpi span{ display:block; font-size:9.5px; color:var(--soft); text-transform:uppercase; letter-spacing:.4px; }
.kpi b{ font-size:16px; color:var(--blue); }
.kpi.pay{ background:var(--blue); border-color:var(--blue); }
.kpi.pay span{ color:#BBD0EE; } .kpi.pay b{ color:#fff; }
.codebox{ text-align:center; font-size:12px; color:var(--soft); margin-top:6px; }
.codebox b{ color:var(--blue); letter-spacing:2px; font-size:15px; }
.foot{ text-align:center; font-size:10.5px; color:#9AA7B4; margin-top:18px; line-height:1.5; }
.integ h3{ margin:0 0 10px; font-size:14px; color:var(--blue); }
.integ .muted{ margin:0; font-size:12.5px; color:var(--soft); }
.chk{ display:flex; gap:10px; align-items:flex-start; padding:7px 0; border-bottom:1px solid var(--line); font-size:13px; }
.chk:last-of-type{ border-bottom:0; }
.chk .dot{ flex:none; width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; color:#fff; }
.chk.ok .dot{ background:#1E7E42; } .chk.bad .dot{ background:#C0392B; } .chk.wait .dot{ background:#C98A12; }
.chk small{ display:block; color:var(--soft); font-size:11.5px; }
.integ .hash{ margin-top:10px; font-size:10.5px; color:var(--soft); word-break:break-all; }
.integ .hash code{ font-size:10.5px; word-break:break-all; overflow-wrap:anywhere; }
.integ .links{ margin-top:8px; font-size:12px; }
.integ .links a{ color:#1E6FD6; }
@media (max-width:480px){
  table, thead, tbody, th, td, tr{ display:block; }
  thead{ display:none; }
  tbody tr{ border:1px solid var(--line); border-radius:8px; margin-bottom:8px; padding:6px 8px; }
  tfoot tr{ background:#EEF3FA; border-radius:8px; padding:6px 8px; }
  td{ border:0; display:flex; justify-content:space-between; text-align:right; padding:3px 0; }
  td::before{ content:attr(data-label); color:var(--soft); font-size:11px; text-align:left; }
}
</style></head><body><div class="wrap">
<div class="verified"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4" stroke="#1E7E42" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="10" stroke="#1E7E42" stroke-width="2"/></svg>Este es el documento original guardado en Genesis Traza — no puede editarse.</div>
<div class="card">
  <div class="top">${logo}<div><h2>${esc(org)}</h2>${s.centro.nit ? `<div class="nit">NIT ${esc(s.centro.nit)}</div>` : ''}${contacto ? `<div class="contact">${contacto}</div>` : ''}</div></div>
  <h1>Balance de masas</h1>
  <div class="ref">Comprobante N° <b>${esc(s.numero)}</b> — ${esc(s.diaSemana)}, ${esc(s.fecha)}</div>
  <div class="kv">
    <div><b>Reciclador</b>${esc(s.reciclador.nombre)}</div>
    <div><b>Documento</b>${esc(s.reciclador.documento)}</div>
    <div><b>NUECA (ECA)</b>${s.operacion.eca ? esc(s.operacion.eca) : '—'}</div>
    <div><b>NUMACRO</b>${s.operacion.macrorruta ? esc(s.operacion.macrorruta) : '—'}</div>
  </div>
</div>
<div class="card">
  <table><thead><tr><th class="l">Material</th><th>Cantidad (kg)</th><th>Valor/kg</th><th>Total</th><th>Rechazo (kg)</th><th>No SUI (kg)</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
  <tfoot><tr><td class="l" data-label="">Total</td><td data-label="Cantidad (kg)">${fmtNum(s.totales.cantidad)}</td><td data-label=""></td><td data-label="Total">${fmtMoney(s.totales.valorTotal)}</td><td data-label="Rechazo (kg)">${fmtNum(s.totales.rechazo)}</td><td data-label="No SUI (kg)">${fmtNum(s.totales.nosui)}</td></tr></tfoot></table>
  <div class="kpis">
    <div class="kpi"><span>Rechazo</span><b>${fmtNum(s.totales.rechazo)} kg</b></div>
    <div class="kpi pay"><span>Total a pagar</span><b>${fmtMoney(s.totales.valorTotal)}</b></div>
  </div>
</div>
${renderIntegridad(v, token)}
<div class="codebox">Código de verificación (compáralo con el del papel impreso)<br><b>${esc(codigo)}</b></div>
<div class="foot">Generado el ${esc(generado)} · Genesis Traza — Módulo Pruebas (sandbox de trazabilidad nativa).<br>Comprobante de prueba, sin validez como factura real.</div>
</div></body></html>`;
}

function renderNotFoundPage() {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comprobante no encontrado</title><style>body{font-family:Arial,Helvetica,sans-serif;background:#F4F7FC;color:#1B2733;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center;}
.box{background:#fff;border:1px solid #DCE3EA;border-radius:14px;padding:28px 24px;max-width:380px;}h1{font-size:17px;color:#0A3369;margin:0 0 8px;}p{font-size:13px;color:#5B6B7C;margin:0;}</style></head>
<body><div class="box"><h1>Comprobante no encontrado</h1><p>El enlace no corresponde a ningún comprobante válido de Genesis Traza.</p></div></body></html>`;
}

// GET /comprobantes/:token -> pagina publica (SIN iniciar sesion) con el comprobante congelado.
// El token debe verse exactamente como se genera (64 hex): cualquier otra cosa es, de una vez, "no encontrado".
router.get('/:token', asyncRoute(async (req, res, next) => {
  if (req.params.token === 'consulta') return next(); // la consulta publica se define mas abajo
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (!/^[0-9a-f]{64}$/.test(req.params.token)) return res.status(404).send(renderNotFoundPage());
  const c = await buscarPorToken(req.params.token);
  if (!c) return res.status(404).send(renderNotFoundPage());
  const v = await huella.verificar('comprobante', c.id, c);
  v.rec = codReciclador(c.id_reciclador);
  res.send(renderPublicPage(c.snapshot, c.codigo_verificacion, c.created_at, v, req.params.token));
}));

async function buscarPorToken(token) {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const r = await pool.query('SELECT id, numero, fecha, id_centro, id_reciclador, snapshot, codigo_verificacion, created_at FROM tz_comprobantes WHERE token = $1', [token]);
  return r.rows[0] || null;
}

// GET /comprobantes/:token/prueba.json -> todo lo necesario para verificar este comprobante sin
// depender de Genesis Traza: el contenido canonico, su huella, la cadena y la prueba Merkle.
router.get('/:token/prueba.json', asyncRoute(async (req, res) => {
  const c = await buscarPorToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Comprobante no encontrado.' });
  const h = (await pool.query("SELECT * FROM tz_huellas WHERE tipo = 'comprobante' AND ref_id = $1", [c.id])).rows[0];
  if (!h) return res.status(404).json({ error: 'Este comprobante aún no tiene huella.' });
  const s = (await pool.query('SELECT fecha, raiz, total, archivo, estado, bloque FROM tz_sellos_diarios WHERE fecha = $1', [h.fecha_sello])).rows[0];
  res.set('Content-Disposition', `attachment; filename="prueba_${c.numero}.json"`);
  res.json({
    como_verificar: [
      '1. sha256(contenido_canonico) debe ser igual a huella_dato.',
      '2. sha256(bytes(huella_prev) + bytes(huella_dato)) debe ser igual a huella.',
      '3. Aplicando prueba_merkle a huella (der: sha256(actual+h), izq: sha256(h+actual)) se obtiene sello_diario.raiz.',
      '4. sha256(sello_diario.archivo) es lo que se ancló en Bitcoin: verifique el archivo .ots en https://opentimestamps.org',
    ],
    contenido_canonico: huella.canonico(huella.FORMATOS[h.version](c)),
    version: h.version, huella_dato: h.huella_dato, huella_prev: h.huella_prev, huella: h.huella, fecha_sello: h.fecha_sello,
    prueba_merkle: h.prueba,
    sello_diario: s ? { ...s, archivo_ots: `/comprobantes/sellos/${s.fecha}/sello.ots`, archivo_texto: `/comprobantes/sellos/${s.fecha}/sello.txt` } : null,
  });
}));

// Archivos publicos del sello diario: el texto anclado y su prueba OpenTimestamps (.ots).
router.get('/sellos/:fecha/sello.txt', asyncRoute(async (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.fecha)) return res.status(404).send('No encontrado');
  const s = (await pool.query('SELECT archivo FROM tz_sellos_diarios WHERE fecha = $1', [req.params.fecha])).rows[0];
  if (!s) return res.status(404).send('No encontrado');
  res.set('Content-Type', 'text/plain; charset=utf-8').set('Content-Disposition', `attachment; filename="sello_${req.params.fecha}.txt"`).send(s.archivo);
}));
router.get('/sellos/:fecha/sello.ots', asyncRoute(async (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.fecha)) return res.status(404).send('No encontrado');
  const s = (await pool.query('SELECT ots FROM tz_sellos_diarios WHERE fecha = $1', [req.params.fecha])).rows[0];
  if (!s || !s.ots) return res.status(404).send('El sello de ese día aún no se ha anclado.');
  res.set('Content-Type', 'application/octet-stream').set('Content-Disposition', `attachment; filename="sello_${req.params.fecha}.txt.ots"`).send(s.ots);
}));

// ============================================================================================
// Consulta publica de trazabilidad (genesistraza.com/verificar.html): se busca por codigo del sello
// diario, por huella, por ID de reciclador (REC-0042) o por numero de comprobante. Solo muestra el
// ID codificado del reciclador, nunca su nombre ni su cedula.
// ============================================================================================
const { codReciclador } = require('../utils/selloDia');

async function estadoSello(tipo, row) {
  const v = await huella.verificar(tipo, row.id, row);
  const s = v.selloDia;
  return {
    integro: v.integro === true, cadena: v.cadena === true, enRaiz: v.enRaiz === true, huella: v.huella, fechaSello: v.fechaSello,
    bitcoin: s ? { estado: s.estado, bloque: s.bloque, fecha: s.fecha, ots: s.tieneOts ? `/comprobantes/sellos/${s.fecha}/sello.ots` : null, txt: `/comprobantes/sellos/${s.fecha}/sello.txt` } : null,
  };
}
const totalesDe = (filas) => filas.reduce((t, f) => ({ cantidad: t.cantidad + Number(f.cantidad || 0), rechazo: t.rechazo + Number(f.rechazo || 0), recicladores: t.recicladores.add(f.reciclador) }), { cantidad: 0, rechazo: 0, recicladores: new Set() });

async function vistaDia(idCentro, fecha) {
  const rows = (await pool.query('SELECT * FROM tz_sellos_asociacion WHERE id_centro = $1 AND fecha = $2 AND huella IS NOT NULL ORDER BY version', [idCentro, fecha])).rows;
  if (!rows.length) return null;
  const versiones = [];
  for (const r of rows) {
    const t = totalesDe(r.datos.filas);
    versiones.push({ version: r.version, codigo: r.codigo, creado: r.creado, motivo: r.motivo, cambios: r.cambios, filas: r.datos.filas,
      totales: { cantidad: t.cantidad, rechazo: t.rechazo, recicladores: t.recicladores.size }, verificacion: await estadoSello('dia', r) });
  }
  return { tipo: 'dia', centro: rows[rows.length - 1].datos.centro, idCentro, fecha, versiones };
}

async function vistaReciclador(id) {
  const cod = codReciclador(id);
  const rows = (await pool.query(
    `SELECT * FROM tz_sellos_asociacion WHERE huella IS NOT NULL AND datos->'filas' @> $1::jsonb ORDER BY fecha DESC, id_centro, version`,
    [JSON.stringify([{ reciclador: cod }])])).rows;
  // Tambien versiones posteriores donde ya no aparece (p. ej. le borraron el registro de ese dia).
  const grupos = new Map();
  for (const r of rows) grupos.set(r.id_centro + '|' + r.fecha, { idCentro: r.id_centro, fecha: r.fecha, todas: [] });
  if (!grupos.size) return null;
  // Todas las versiones de esos dias en una sola consulta.
  const centros = [...grupos.values()].map((g) => g.idCentro), fechas = [...grupos.values()].map((g) => g.fecha);
  const versiones = (await pool.query(
    `SELECT s.* FROM tz_sellos_asociacion s JOIN unnest($1::int[], $2::date[]) AS k(c, f) ON s.id_centro = k.c AND s.fecha = k.f
     WHERE s.huella IS NOT NULL ORDER BY s.version`, [centros, fechas])).rows;
  for (const v of versiones) grupos.get(v.id_centro + '|' + v.fecha).todas.push(v);
  const dias = [];
  for (const g of grupos.values()) {
    const todas = g.todas;
    const actual = todas[todas.length - 1];
    const mias = (v) => v.datos.filas.filter((f) => f.reciclador === cod);
    const firma = (v) => huella.canonico(mias(v));
    const cambiado = todas.some((v) => firma(v) !== firma(actual));
    const filas = mias(actual);
    dias.push({ fecha: g.fecha, centro: actual.datos.centro, codigo: actual.codigo, versiones: todas.length, cambiado, filas,
      cantidad: filas.reduce((s, f) => s + Number(f.cantidad || 0), 0), rechazo: filas.reduce((s, f) => s + Number(f.rechazo || 0), 0),
      verificacion: await estadoSello('dia', actual) });
  }
  if (!dias.length) return null;
  return { tipo: 'reciclador', reciclador: cod, dias };
}

// GET /comprobantes/consulta?q=...
router.get('/consulta', asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Escribe un código para consultar.' });
  const Q = q.toUpperCase();
  let m;
  // Codigo del sello completo (GT8-20261001-V2-EF4D44) o corto: GT8-20261001 (version actual) o GT8-20261001-V2.
  if ((m = Q.match(/^GT(\d+)-(\d{4})(\d{2})(\d{2})(?:-V(\d+))?(?:-[0-9A-F]{6})?$/))) {
    const fecha = `${m[2]}-${m[3]}-${m[4]}`;
    const s = (await pool.query(
      `SELECT id_centro, fecha, version FROM tz_sellos_asociacion WHERE id_centro = $1 AND fecha = $2 AND huella IS NOT NULL
       AND ($3::int IS NULL OR version = $3) ORDER BY version DESC LIMIT 1`, [Number(m[1]), fecha, m[5] ? Number(m[5]) : null])).rows[0];
    if (s) { const v = await vistaDia(s.id_centro, s.fecha); return res.json({ ...v, buscada: s.version }); }
  } else if (/^[0-9A-F]{64}$/.test(Q)) {
    const h = (await pool.query('SELECT tipo, ref_id FROM tz_huellas WHERE huella = $1 OR huella_dato = $1 LIMIT 1', [q.toLowerCase()])).rows[0];
    if (h && h.tipo === 'dia') {
      const s = (await pool.query('SELECT id_centro, fecha, version FROM tz_sellos_asociacion WHERE id = $1', [h.ref_id])).rows[0];
      if (s) { const v = await vistaDia(s.id_centro, s.fecha); return res.json({ ...v, buscada: s.version }); }
    }
    if (h && h.tipo === 'comprobante') {
      const c = (await pool.query('SELECT token, numero FROM tz_comprobantes WHERE id = $1', [h.ref_id])).rows[0];
      if (c) return res.json({ tipo: 'comprobante', numero: c.numero, url: `/comprobantes/${c.token}` });
    }
  } else if ((m = Q.match(/^REC-?(\d{1,9})$/))) {
    const v = await vistaReciclador(Number(m[1]));
    if (v) return res.json(v);
  } else if (/^BM-\d{8}-\d{4}-[0-9A-F]{6}$/.test(Q)) {
    const c = (await pool.query('SELECT token, numero FROM tz_comprobantes WHERE numero = $1', [Q])).rows[0];
    if (c) return res.json({ tipo: 'comprobante', numero: c.numero, url: `/comprobantes/${c.token}` });
  }
  res.status(404).json({ error: 'No se encontró ningún registro sellado con ese código.' });
}));

// GET /comprobantes/carga/:id -> detalle publico de una carga masiva programada (transparencia ante
// la SSPD): cuando se subio el archivo, su huella sha256, a que hora se programo y cuando se aplico.
router.get('/carga/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Carga no encontrada.' });
  const c = (await pool.query(
    `SELECT id, entidad, archivo_nombre, archivo_sha256, filas_validas, filas_omitidas, programada_para, estado, subido_en, ejecutada_en, cancelada_en
     FROM tz_cargas_programadas WHERE id = $1`, [id])).rows[0];
  if (!c) return res.status(404).json({ error: 'Carga no encontrada.' });
  res.json(c);
}));

// GET /comprobantes/sello-dia/:codigo/prueba.json -> prueba tecnica de un sello diario.
router.get('/sello-dia/:codigo/prueba.json', asyncRoute(async (req, res) => {
  const s = (await pool.query('SELECT * FROM tz_sellos_asociacion WHERE codigo = $1', [String(req.params.codigo).toUpperCase()])).rows[0];
  if (!s) return res.status(404).json({ error: 'Sello no encontrado.' });
  const h = (await pool.query("SELECT * FROM tz_huellas WHERE tipo = 'dia' AND ref_id = $1", [s.id])).rows[0];
  const d = h ? (await pool.query('SELECT fecha, raiz, total, archivo, estado, bloque FROM tz_sellos_diarios WHERE fecha = $1', [h.fecha_sello])).rows[0] : null;
  res.set('Content-Disposition', `attachment; filename="prueba_${s.codigo}.json"`);
  res.json({
    como_verificar: [
      '1. sha256(contenido_canonico) debe ser igual a huella_dato.',
      '2. sha256(bytes(huella_prev) + bytes(huella_dato)) debe ser igual a huella.',
      '3. Aplicando prueba_merkle a huella (der: sha256(actual+h), izq: sha256(h+actual)) se obtiene sello_diario.raiz.',
      '4. sha256(sello_diario.archivo) es lo que se ancló en Bitcoin: verifique el archivo .ots en https://opentimestamps.org',
    ],
    codigo: s.codigo,
    contenido_canonico: h ? huella.canonico(huella.FORMATOS[h.version](s)) : null,
    huella_dato: h && h.huella_dato, huella_prev: h && h.huella_prev, huella: h && h.huella, fecha_sello: h && h.fecha_sello, prueba_merkle: h && h.prueba,
    sello_diario: d ? { ...d, archivo_ots: `/comprobantes/sellos/${d.fecha}/sello.ots`, archivo_texto: `/comprobantes/sellos/${d.fecha}/sello.txt` } : null,
  });
}));

module.exports = router;
