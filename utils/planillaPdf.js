// Dibuja una "Planilla de recepción de material" (comprobante mensual por reciclador con las
// cantidades entregadas por semana) replicando el formato que ya se venia usando en la
// asociacion: encabezado con datos del centro, barra de titulo verde, cuadro de datos del
// reciclador/periodo, tabla de materiales por semana y firma.
const GREEN_DARK = '#3E7A3E';
const GREEN_LIGHT = '#EAF3EA';
const GREEN_MED = '#C9E4C9';
const INK = '#1B2733';
const INK_SOFT = '#5B6B7C';
const LINE = '#DCE3EA';

function fmtKg(n) {
  return Number(n || 0).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function drawPlanilla(doc, data) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  let y = doc.page.margins.top;

  // Logo a la izquierda (como en la planilla original) y los datos de la asociacion a la derecha.
  let logoBottom = y;
  let textLeft = left;
  let textWidth = width;
  if (data.centro.logoBuffer) {
    try {
      doc.image(data.centro.logoBuffer, left, y, { fit: [130, 62] });
      logoBottom = y + 62;
      textLeft = left + 145;
      textWidth = width - 145;
    } catch (e) { /* imagen ilegible: se imprime sin logo */ }
  }

  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
    .text(data.centro.desc_centro || 'Asociación', textLeft, y, { width: textWidth, align: 'right' });
  y = doc.y + 2;
  doc.font('Helvetica').fontSize(8).fillColor(INK_SOFT);
  if (data.centro.nit) { doc.text('NIT. ' + data.centro.nit, textLeft, y, { width: textWidth, align: 'right' }); y = doc.y; }
  if (data.centro.direccion) { doc.text(data.centro.direccion, textLeft, y, { width: textWidth, align: 'right' }); y = doc.y; }
  const contacto = [data.centro.telefono, data.centro.correo].filter(Boolean).join('  -  ');
  if (contacto) { doc.text(contacto, textLeft, y, { width: textWidth, align: 'right' }); y = doc.y; }

  y = Math.max(y, logoBottom) + 10;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
  y += 14;

  doc.rect(left, y, width, 26).fill(GREEN_DARK);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13)
    .text('PLANILLA DE RECEPCIÓN DE MATERIAL', left, y + 7, { width, align: 'center' });
  y += 26 + 12;

  const colW = width / 2;
  const rowH = 30;
  const infoRows = [
    ['Recuperador', data.reciclador.nombre_completo || '—', 'Cédula / NIT', data.reciclador.nro_documento || '—'],
    ['Bodega', data.bodega || '—', 'Periodo', data.periodoLabel],
    ['Tipo (VEH)', data.reciclador.tipo_de_vehiculo || '—', 'Placa / Código', data.reciclador.placa || '—'],
    ['Ruta', data.macrorruta ? 'SI' : 'NO', 'NUMACRO', data.macrorruta || '—']
  ];
  infoRows.forEach((r, i) => {
    const ry = y + i * rowH;
    doc.rect(left, ry, width, rowH).fillAndStroke(i % 2 === 0 ? '#F7F9FB' : '#FFFFFF', LINE);
    doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7.5).text(r[0], left + 8, ry + 5, { width: colW - 16 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(String(r[1]), left + 8, ry + 15, { width: colW - 16 });
    doc.fillColor(INK_SOFT).font('Helvetica').fontSize(7.5).text(r[2], left + colW + 8, ry + 5, { width: colW - 16 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(String(r[3]), left + colW + 8, ry + 15, { width: colW - 16 });
  });
  y += infoRows.length * rowH + 16;

  const colMaterial = width * 0.28;
  const colWeek = width * 0.145;
  const colTotal = width - colMaterial - colWeek * 4;
  const cols = [colMaterial, colWeek, colWeek, colWeek, colWeek, colTotal];
  const headers = [
    'Material',
    '1ª Semana ' + data.ranges[0].label,
    '2ª Semana ' + data.ranges[1].label,
    '3ª Semana ' + data.ranges[2].label,
    '4ª Semana ' + data.ranges[3].label,
    'Total (kg)'
  ];

  function row(yPos, cells, opts) {
    opts = opts || {};
    const h = opts.height || 18;
    if (opts.fill) doc.rect(left, yPos, width, h).fill(opts.fill);
    let x = left;
    cells.forEach((c, i) => {
      doc.fillColor(opts.color || INK).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.fontSize || 8);
      doc.text(String(c), x + 4, yPos + (h - (opts.fontSize || 8)) / 2, { width: cols[i] - 8, align: i === 0 ? 'left' : 'right' });
      x += cols[i];
    });
    return yPos + h;
  }

  y = row(y, headers, { fill: GREEN_DARK, color: '#FFFFFF', bold: true, height: 24, fontSize: 7 });
  data.materiales.forEach((m, idx) => {
    if (y > doc.page.height - doc.page.margins.bottom - 140) {
      doc.addPage();
      y = doc.page.margins.top;
      y = row(y, headers, { fill: GREEN_DARK, color: '#FFFFFF', bold: true, height: 24, fontSize: 7 });
    }
    const rowFill = idx % 2 === 0 ? '#FFFFFF' : '#F7F9FB';
    y = row(y, [m.nombre, fmtKg(m.vals[0]), fmtKg(m.vals[1]), fmtKg(m.vals[2]), fmtKg(m.vals[3]), fmtKg(m.total)], { fill: rowFill, fontSize: 8 });
  });
  y = row(y, ['TOTAL KGS x SEMANA', fmtKg(data.totalPorSemana[0]), fmtKg(data.totalPorSemana[1]), fmtKg(data.totalPorSemana[2]), fmtKg(data.totalPorSemana[3]), fmtKg(data.totalPeriodo)],
    { fill: GREEN_MED, bold: true, height: 20, fontSize: 8 });

  y += 14;
  doc.rect(left, y, width, 26).fillAndStroke(GREEN_LIGHT, GREEN_DARK);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text('TOTAL KILOGRAMOS DEL PERIODO', left + 10, y + 8);
  doc.fontSize(11).text(fmtKg(data.totalPeriodo) + ' kg', left, y + 7, { width: width - 12, align: 'right' });
  y += 26 + 34;

  if (y > doc.page.height - doc.page.margins.bottom - 40) { doc.addPage(); y = doc.page.margins.top; }
  doc.moveTo(left, y).lineTo(left + 220, y).strokeColor(INK).lineWidth(1).stroke();
  y += 4;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(data.reciclador.nombre_completo || '', left, y);
  y = doc.y + 2;
  doc.font('Helvetica').fontSize(8).fillColor(INK).text('C.C. / NIT ' + (data.reciclador.nro_documento || ''), left, y);
}

// Rangos de semana DENTRO DEL MES para agrupar el balance de masas: 1-7, 8-14, 15-21 y
// 22-fin de mes (la semana 4 absorbe los dias restantes, igual que en la planilla original).
function weekBucketRanges(anio, mes) {
  const mesesCorto = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const lastDay = new Date(anio, mes, 0).getDate();
  const ranges = [[1, 7], [8, 14], [15, 21], [22, lastDay]];
  return ranges.map(([desde, hasta]) => ({ desde, hasta, label: `(${desde}-${hasta} ${mesesCorto[mes - 1]})` }));
}

function bucketForDay(day, ranges) {
  for (let i = 0; i < ranges.length; i++) {
    if (day >= ranges[i].desde && day <= ranges[i].hasta) return i;
  }
  return ranges.length - 1;
}

function slugName(nombre) {
  return String(nombre || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

module.exports = { drawPlanilla, weekBucketRanges, bucketForDay, slugName };
