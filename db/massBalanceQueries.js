const pool = require('./pool');

// Traduce (period, value) a una condicion SQL y a la granularidad con la que se debe agrupar
// la grafica: por año -> se agrupa por mes; por mes o por semana -> se agrupa por dia.
function resolvePeriodFilter(period, value) {
  if (period === 'year' && value) {
    return { whereExtra: "AND to_char(fecha,'YYYY') = $2", params: [value], groupExpr: "to_char(date_trunc('month', fecha), 'YYYY-MM')", groupBy: 'month' };
  }
  if (period === 'month' && value) {
    return { whereExtra: "AND to_char(fecha,'YYYY-MM') = $2", params: [value], groupExpr: "to_char(fecha, 'YYYY-MM-DD')", groupBy: 'day' };
  }
  if (period === 'week' && value) {
    const [year, week] = value.split('-');
    return { whereExtra: 'AND to_char(fecha,\'YYYY\') = $2 AND semana = $3', params: [year, Number(week)], groupExpr: "to_char(fecha, 'YYYY-MM-DD')", groupBy: 'day' };
  }
  return { whereExtra: '', params: [], groupExpr: "to_char(date_trunc('month', fecha), 'YYYY-MM')", groupBy: 'month' };
}

// Resumen agregado del balance de masas de una asociación: totales, por periodo y por material.
// Se usa tanto desde el dashboard del cliente (su propia asociación) como desde el panel de
// administración (la asociación que el admin elija). period/value permiten acotar a una
// semana, un mes o un año concretos en vez de traer siempre todo el historico.
async function getMassBalanceSummary(associationId, period, value) {
  const filter = resolvePeriodFilter(period, value);
  const params = [associationId, ...filter.params];

  const totals = await pool.query(
    `SELECT
       COALESCE(SUM(toneladas), 0) AS total_toneladas,
       COALESCE(SUM(toneladas_rechazo), 0) AS total_toneladas_rechazo,
       COALESCE(SUM(valor_total), 0) AS total_valor,
       COUNT(*) AS total_entradas,
       COUNT(DISTINCT reciclador_documento) AS recicladores_activos,
       MIN(fecha) AS fecha_min,
       MAX(fecha) AS fecha_max
     FROM mass_balance_entries WHERE association_id = $1 ${filter.whereExtra}`,
    params
  );

  const byPeriod = await pool.query(
    `SELECT ${filter.groupExpr} AS bucket,
            COALESCE(SUM(toneladas), 0) AS toneladas,
            COALESCE(SUM(valor_total), 0) AS valor
     FROM mass_balance_entries WHERE association_id = $1 ${filter.whereExtra}
     GROUP BY 1 ORDER BY 1`,
    params
  );

  const byMaterial = await pool.query(
    `SELECT material_desc,
            COALESCE(SUM(toneladas), 0) AS toneladas,
            COALESCE(SUM(valor_total), 0) AS valor
     FROM mass_balance_entries WHERE association_id = $1 ${filter.whereExtra}
     GROUP BY material_desc ORDER BY toneladas DESC`,
    params
  );

  const recent = await pool.query(
    `SELECT fecha, reciclador_nombre, material_desc, toneladas, valor_total
     FROM mass_balance_entries WHERE association_id = $1 ${filter.whereExtra}
     ORDER BY fecha DESC, id DESC LIMIT 30`,
    params
  );

  return {
    totals: totals.rows[0],
    byPeriod: byPeriod.rows,
    groupBy: filter.groupBy,
    byMaterial: byMaterial.rows,
    recent: recent.rows
  };
}

// Lista los años, meses y semanas que realmente tienen datos, para poblar los selectores de
// filtro sin adivinar rangos vacios.
async function getMassBalancePeriods(associationId) {
  const years = await pool.query(
    `SELECT DISTINCT to_char(fecha,'YYYY') AS year FROM mass_balance_entries
     WHERE association_id = $1 ORDER BY 1 DESC`,
    [associationId]
  );
  const months = await pool.query(
    `SELECT DISTINCT to_char(fecha,'YYYY-MM') AS month FROM mass_balance_entries
     WHERE association_id = $1 ORDER BY 1 DESC`,
    [associationId]
  );
  const weeks = await pool.query(
    `SELECT to_char(fecha,'YYYY') AS year, semana, MIN(fecha) AS inicio, MAX(fecha) AS fin
     FROM mass_balance_entries WHERE association_id = $1 AND semana IS NOT NULL
     GROUP BY 1, 2 ORDER BY 1 DESC, 2 DESC`,
    [associationId]
  );
  return {
    years: years.rows.map((r) => r.year),
    months: months.rows.map((r) => r.month),
    weeks: weeks.rows.map((r) => ({
      value: r.year + '-' + String(r.semana).padStart(2, '0'),
      year: r.year,
      semana: r.semana,
      inicio: r.inicio,
      fin: r.fin
    }))
  };
}

// Recicladores de la asociacion con lo que gano cada uno en un mes puntual: toneladas
// aprovechadas (no cuenta el rechazo) y el pago correspondiente, sumando sus entradas de
// balance de masas de ese mes. Si no se pasa "month" usa el mes calendario actual.
async function getRecicladoresConPagoMes(associationId, month) {
  // Mes actual en Colombia (toISOString usa UTC: despues de las 7 p. m. del ultimo dia del mes ya
  // "era" el mes siguiente y la lista salia en cero).
  const targetMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))
    ? month
    : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }).slice(0, 7);
  const result = await pool.query(
    `SELECT r.id, r.documento_numero, r.nombre_completo,
            COALESCE(m.toneladas, 0) AS toneladas_mes,
            COALESCE(m.valor_total, 0) AS pago_mes
     FROM recicladores r
     LEFT JOIN (
       SELECT reciclador_documento, SUM(toneladas) AS toneladas, SUM(valor_total) AS valor_total
       FROM mass_balance_entries
       WHERE association_id = $1 AND to_char(fecha, 'YYYY-MM') = $2
       GROUP BY reciclador_documento
     ) m ON m.reciclador_documento = r.documento_numero
     WHERE r.association_id = $1
     ORDER BY r.nombre_completo`,
    [associationId, targetMonth]
  );
  return { month: targetMonth, recicladores: result.rows };
}

module.exports = { getMassBalanceSummary, getMassBalancePeriods, getRecicladoresConPagoMes };
