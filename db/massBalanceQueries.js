const pool = require('./pool');

// Resumen agregado del balance de masas de una asociación: totales, por mes y por material.
// Se usa tanto desde el dashboard del cliente (su propia asociación) como desde el panel de
// administración (la asociación que el admin elija).
async function getMassBalanceSummary(associationId) {
  const totals = await pool.query(
    `SELECT
       COALESCE(SUM(toneladas), 0) AS total_toneladas,
       COALESCE(SUM(toneladas_rechazo), 0) AS total_toneladas_rechazo,
       COALESCE(SUM(valor_total), 0) AS total_valor,
       COUNT(*) AS total_entradas,
       COUNT(DISTINCT reciclador_documento) AS recicladores_activos,
       MIN(fecha) AS fecha_min,
       MAX(fecha) AS fecha_max
     FROM mass_balance_entries WHERE association_id = $1`,
    [associationId]
  );

  const byMonth = await pool.query(
    `SELECT to_char(date_trunc('month', fecha), 'YYYY-MM') AS mes,
            COALESCE(SUM(toneladas), 0) AS toneladas,
            COALESCE(SUM(valor_total), 0) AS valor
     FROM mass_balance_entries WHERE association_id = $1
     GROUP BY 1 ORDER BY 1`,
    [associationId]
  );

  const byMaterial = await pool.query(
    `SELECT material_desc,
            COALESCE(SUM(toneladas), 0) AS toneladas,
            COALESCE(SUM(valor_total), 0) AS valor
     FROM mass_balance_entries WHERE association_id = $1
     GROUP BY material_desc ORDER BY toneladas DESC`,
    [associationId]
  );

  const recent = await pool.query(
    `SELECT fecha, reciclador_nombre, material_desc, toneladas, valor_total
     FROM mass_balance_entries WHERE association_id = $1
     ORDER BY fecha DESC, id DESC LIMIT 30`,
    [associationId]
  );

  return {
    totals: totals.rows[0],
    byMonth: byMonth.rows,
    byMaterial: byMaterial.rows,
    recent: recent.rows
  };
}

async function getRecicladores(associationId) {
  const result = await pool.query(
    `SELECT id, documento_numero, nombre_completo, estado, direccion, telefono, tipo_vehiculo, placa,
            fecha_exp_documento, fecha_nacimiento
     FROM recicladores WHERE association_id = $1 ORDER BY nombre_completo`,
    [associationId]
  );
  return result.rows;
}

module.exports = { getMassBalanceSummary, getRecicladores };
