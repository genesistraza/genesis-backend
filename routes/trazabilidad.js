// Modulo "Pruebas": motor generico de CRUD para las tablas tz_* (trazabilidad nativa).
// En vez de una ruta/pantalla por formulario (como el sistema original en ASP.NET), un
// solo registro de entidades con metadata de campos alimenta tanto el backend genérico
// como el frontend, que arma tablas y formularios dinámicamente a partir de esa metadata.
// Aislado del resto de la app: nunca toca associations/recicladores/mass_balance_entries.
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');

const router = express.Router();
router.use(requireAuth, requireRole('pro'));
const uploadExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const ENTITIES = {
  centros: {
    table: 'tz_centros', label: 'Centros (Asociaciones)',
    fields: [
      { name: 'cod_centro', label: 'Código', type: 'text' },
      { name: 'desc_centro', label: 'Nombre', type: 'text', required: true },
      { name: 'rup_numero', label: 'Número RUP', type: 'text' },
      { name: 'rup_fecha_inscripcion', label: 'Fecha inscripción RUP', type: 'date' },
      { name: 'eca_numero', label: 'Número ECA', type: 'text' }
    ]
  },
  bodegas: {
    table: 'tz_bodegas', label: 'Bodegas',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'cod_bodega', label: 'Código', type: 'text' },
      { name: 'desc_bodega', label: 'Descripción', type: 'text' },
      { name: 'desc_ubicacion', label: 'Ubicación', type: 'text' },
      { name: 'direccion', label: 'Dirección', type: 'text' }
    ]
  },
  localidades: {
    table: 'tz_localidades', label: 'Localidades',
    fields: [
      { name: 'cod_localidad', label: 'Código', type: 'text' },
      { name: 'desc_localidad', label: 'Nombre', type: 'text', required: true },
      { name: 'ciudad', label: 'Ciudad', type: 'text' }
    ]
  },
  numacros: {
    table: 'tz_numacros', label: 'Numacros (Zonas)',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'id_localidad', label: 'Localidad', type: 'select-entity', entity: 'localidades', labelField: 'desc_localidad' },
      { name: 'cod_numacro', label: 'Código', type: 'text' }
    ]
  },
  tipos_material: {
    table: 'tz_tipos_material', label: 'Tipos de Material',
    fields: [
      { name: 'cod_tipo_material', label: 'Código', type: 'text' },
      { name: 'desc_familia', label: 'Familia', type: 'text' },
      { name: 'desc_tipo_material', label: 'Material', type: 'text', required: true },
      { name: 'secuencia_orden', label: 'Orden', type: 'number' }
    ]
  },
  recicladores: {
    table: 'tz_recicladores', label: 'Recicladores',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'nombre_completo', label: 'Nombre completo', type: 'text', required: true },
      { name: 'nro_documento', label: 'Documento', type: 'text', required: true },
      { name: 'estado', label: 'Estado', type: 'text' },
      { name: 'fecha_exp_documento', label: 'Fecha expedición doc.', type: 'date' },
      { name: 'fecha_nacimiento', label: 'Fecha nacimiento', type: 'date' },
      { name: 'direccion', label: 'Dirección', type: 'text' },
      { name: 'telefono', label: 'Teléfono', type: 'text' },
      { name: 'tipo_de_vehiculo', label: 'Tipo vehículo', type: 'text' },
      { name: 'placa', label: 'Placa', type: 'text' }
    ]
  },
  balance_masas: {
    table: 'tz_formulario_balance_masas', label: 'Balance de Masas',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'id_reciclador', label: 'Reciclador', type: 'select-entity', entity: 'recicladores', labelField: 'nombre_completo', required: true },
      { name: 'id_tipo_material', label: 'Material', type: 'select-entity', entity: 'tipos_material', labelField: 'desc_tipo_material', required: true },
      { name: 'id_numacro', label: 'Numacro', type: 'select-entity', entity: 'numacros', labelField: 'cod_numacro' },
      { name: 'id_bodega', label: 'Bodega', type: 'select-entity', entity: 'bodegas', labelField: 'desc_bodega' },
      { name: 'id_macrorruta', label: 'Macrorruta', type: 'select-entity', entity: 'macrorrutas', labelField: 'desc_macrorruta' },
      { name: 'fecha', label: 'Fecha', type: 'date', required: true },
      { name: 'cantidad', label: 'Cantidad (kg)', type: 'decimal' },
      { name: 'valor', label: 'Valor/kg', type: 'decimal' },
      { name: 'cantidad_rechazo', label: 'Cantidad rechazo', type: 'decimal' },
      { name: 'cantidad_nosui', label: 'Cantidad no SUI', type: 'decimal' }
    ]
  },
  macrorrutas: {
    table: 'tz_macrorrutas', label: 'Macrorrutas',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'cod_macrorruta', label: 'Código', type: 'text' },
      { name: 'desc_macrorruta', label: 'Descripción', type: 'text', required: true }
    ]
  },
  formalizacion_fases: {
    table: 'tz_formalizacion_fases', label: 'Formalización (Decreto 596/2016)',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'fase', label: 'Fase (1-8)', type: 'number', required: true },
      { name: 'descripcion_fase', label: 'Descripción de la fase', type: 'text' },
      { name: 'estado', label: 'Estado (Pendiente/En proceso/Completada)', type: 'text' },
      { name: 'fecha_completada', label: 'Fecha completada', type: 'date' },
      { name: 'observaciones', label: 'Observaciones', type: 'text' }
    ]
  },
  pqr: {
    table: 'tz_pqr', label: 'PQR',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'tipo', label: 'Tipo (Peticion/Queja/Reclamo)', type: 'text' },
      { name: 'fecha', label: 'Fecha', type: 'date' },
      { name: 'nombre_solicitante', label: 'Nombre solicitante', type: 'text' },
      { name: 'documento_solicitante', label: 'Documento solicitante', type: 'text' },
      { name: 'descripcion', label: 'Descripción', type: 'text' },
      { name: 'estado', label: 'Estado (Abierta/En proceso/Cerrada)', type: 'text' },
      { name: 'fecha_respuesta', label: 'Fecha respuesta', type: 'date' },
      { name: 'respuesta', label: 'Respuesta', type: 'text' }
    ]
  },
  seguridad_social: {
    table: 'tz_seguridad_social', label: 'Seguridad Social (Decreto 271/2026)',
    fields: [
      { name: 'id_reciclador', label: 'Reciclador', type: 'select-entity', entity: 'recicladores', labelField: 'nombre_completo', required: true },
      { name: 'eps', label: 'EPS', type: 'text' },
      { name: 'estado_afiliacion_eps', label: 'Estado afiliación EPS', type: 'text' },
      { name: 'arl', label: 'ARL', type: 'text' },
      { name: 'estado_afiliacion_arl', label: 'Estado afiliación ARL', type: 'text' },
      { name: 'base_cotizacion_arl', label: 'Base cotización ARL', type: 'decimal' },
      { name: 'beps_afiliado', label: 'Afiliado a BEPS (1 = sí, 0 = no)', type: 'text' },
      { name: 'aporte_beps_mensual', label: 'Aporte BEPS mensual', type: 'decimal' },
      { name: 'fecha_actualizacion', label: 'Fecha actualización', type: 'date' }
    ]
  },
  microrrutas: {
    table: 'tz_formulario_microrrutas', label: 'Microrrutas',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'id_reciclador', label: 'Reciclador', type: 'select-entity', entity: 'recicladores', labelField: 'nombre_completo' },
      { name: 'fecha_entrada_operacion', label: 'Fecha entrada operación', type: 'date' },
      { name: 'estado', label: 'Estado', type: 'text' }
    ]
  },
  microrrutas_detalle: {
    table: 'tz_formulario_microrrutas_detalle', label: 'Detalle de Microrrutas',
    fields: [
      { name: 'id_formulario_microrruta', label: 'Microrruta (id)', type: 'select-entity', entity: 'microrrutas', labelField: 'id', required: true },
      { name: 'desc_microrruta', label: 'Descripción', type: 'text' },
      { name: 'id_tipo_microrruta', label: 'Tipo', type: 'select-catalogo', categoria: 'tipos_microrruta' },
      { name: 'direccion_inicio', label: 'Dirección inicio', type: 'text' },
      { name: 'hora_inicio', label: 'Hora inicio', type: 'text' },
      { name: 'direccion_finalizacion', label: 'Dirección fin', type: 'text' },
      { name: 'hora_finalizacion', label: 'Hora fin', type: 'text' },
      { name: 'distancia_via_pavimentada', label: 'Distancia pavimentada (km)', type: 'decimal' },
      { name: 'distancia_via_no_pavimentada', label: 'Distancia no pavimentada (km)', type: 'decimal' },
      { name: 'frecuencia_semanal', label: 'Frecuencia semanal', type: 'number' },
      { name: 'dias_frecuencia', label: 'Días', type: 'text' },
      { name: 'id_estacion_transferencia', label: 'Estación transferencia', type: 'select-catalogo', categoria: 'estaciones_transferencia' },
      { name: 'tipo_barrido', label: 'Tipo barrido', type: 'text' }
    ]
  },
  usuarios: {
    table: 'tz_usuarios', label: 'Usuarios del Servicio (SUI)',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'id_numacro', label: 'Numacro', type: 'select-entity', entity: 'numacros', labelField: 'cod_numacro' },
      { name: 'nuis_nuid', label: 'NUIS/NUID', type: 'text' },
      { name: 'direccion_usuario', label: 'Dirección', type: 'text' },
      { name: 'id_usuario_uso', label: 'Uso', type: 'select-catalogo', categoria: 'usuario_uso' },
      { name: 'id_usuario_tipo', label: 'Tipo', type: 'select-catalogo', categoria: 'usuario_tipo' },
      { name: 'id_usuario_multiusuario', label: 'Multiusuario', type: 'select-catalogo', categoria: 'usuario_multiusuario' },
      { name: 'id_usuario_ubicacion', label: 'Ubicación', type: 'select-catalogo', categoria: 'usuario_ubicacion' },
      { name: 'id_usuario_clase_de_uso', label: 'Clase de uso', type: 'select-catalogo', categoria: 'usuario_clase_de_uso' },
      { name: 'id_usuario_tipo_de_aforo', label: 'Tipo de aforo', type: 'select-catalogo', categoria: 'usuario_tipo_de_aforo' }
    ]
  },
  aprovechamiento: {
    table: 'tz_formulario_aprovechamiento', label: 'Aprovechamiento',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'id_usuario', label: 'Usuario', type: 'select-entity', entity: 'usuarios', labelField: 'nuis_nuid' },
      { name: 'id_numacro', label: 'Numacro', type: 'select-entity', entity: 'numacros', labelField: 'cod_numacro' },
      { name: 'periodo', label: 'Periodo', type: 'text' },
      { name: 'toneladas', label: 'Toneladas', type: 'decimal' }
    ]
  },
  recursos: {
    table: 'tz_formulario_recursos', label: 'Recursos',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'fecha', label: 'Fecha', type: 'date' },
      { name: 'nuap', label: 'NUAP', type: 'text' },
      { name: 'operador', label: 'Operador', type: 'text' },
      { name: 'valor', label: 'Valor', type: 'decimal' }
    ]
  },
  ventas: {
    table: 'tz_formulario_ventas', label: 'Ventas',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'anio', label: 'Año', type: 'number' },
      { name: 'periodo', label: 'Periodo', type: 'text' },
      { name: 'fecha_habilitacion', label: 'Fecha habilitación', type: 'date' },
      { name: 'fecha_certificacion', label: 'Fecha certificación', type: 'date' },
      { name: 'tipo_identificacion', label: 'Tipo identificación', type: 'text' },
      { name: 'nro_identificacion', label: 'Nro identificación', type: 'text' },
      { name: 'nro_factura', label: 'Nro factura', type: 'text' },
      { name: 'nombre_comprador', label: 'Comprador', type: 'text' },
      { name: 'material', label: 'Material', type: 'text' },
      { name: 'kg', label: 'Kg', type: 'decimal' },
      { name: 'toneladas', label: 'Toneladas', type: 'decimal' },
      { name: 'valor_kilo', label: 'Valor/kg', type: 'decimal' },
      { name: 'valor_sin_iva', label: 'Valor sin IVA', type: 'decimal' },
      { name: 'iva', label: 'IVA', type: 'decimal' },
      { name: 'valor_con_iva', label: 'Valor con IVA', type: 'decimal' },
      { name: 'depto_origen', label: 'Depto origen', type: 'text' },
      { name: 'municipio_origen', label: 'Municipio origen', type: 'text' },
      { name: 'origen_residuos', label: 'Origen residuos', type: 'text' }
    ]
  },
  pago_seguridad: {
    table: 'tz_formulario_pago_seguridad', label: 'Pago Seguridad Social',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'id_reciclador', label: 'Reciclador', type: 'select-entity', entity: 'recicladores', labelField: 'nombre_completo', required: true },
      { name: 'id_tipo_concepto', label: 'Concepto', type: 'select-catalogo', categoria: 'tipos_concepto_pago_seguridad' },
      { name: 'fecha', label: 'Fecha', type: 'date' },
      { name: 'planilla', label: 'Planilla', type: 'text' },
      { name: 'cantidad', label: 'Cantidad', type: 'decimal' },
      { name: 'valor', label: 'Valor', type: 'decimal' }
    ]
  },
  pago_tarifa: {
    table: 'tz_formulario_pago_tarifa', label: 'Pago Tarifa',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'id_reciclador', label: 'Reciclador', type: 'select-entity', entity: 'recicladores', labelField: 'nombre_completo', required: true },
      { name: 'id_tipo_concepto', label: 'Concepto', type: 'select-catalogo', categoria: 'tipos_concepto_pago_tarifa' },
      { name: 'fecha', label: 'Fecha', type: 'date' },
      { name: 'nro_referencia', label: 'Nro referencia', type: 'text' },
      { name: 'cantidad', label: 'Cantidad', type: 'decimal' },
      { name: 'valor', label: 'Valor', type: 'decimal' }
    ]
  }
};

function getEntity(key) {
  const entity = ENTITIES[key];
  if (!entity) return null;
  return entity;
}

// GET /trazabilidad/entities -> el registro completo, para que el frontend arme menú,
// tablas y formularios sin tener que hardcodear nada por módulo.
router.get('/entities', (req, res) => {
  const out = {};
  for (const key in ENTITIES) {
    out[key] = { label: ENTITIES[key].label, fields: ENTITIES[key].fields };
  }
  res.json(out);
});

// GET /trazabilidad/catalogo-options/:categoria -> opciones {value,label} para un select-catalogo
router.get('/catalogo-options/:categoria', asyncRoute(async (req, res) => {
  const result = await pool.query(
    'SELECT id AS value, descripcion AS label FROM tz_catalogos WHERE categoria = $1 ORDER BY orden, descripcion',
    [req.params.categoria]
  );
  res.json(result.rows);
}));

// ---- Cargue masivo (Excel/CSV) para cualquier modulo: mismo patron que los cargues de Excel ----
// que ya existen para el sistema real (mass_balance_entries/recicladores en routes/admin.js), pero
// generico: mapea columnas por el nombre o la etiqueta del campo, sin necesitar una ruta por modulo.
function normalizeHeader(s) {
  return String(s === null || s === undefined ? '' : s).trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}
function normalizeRowKeys(row) {
  const out = {};
  for (const key in row) out[normalizeHeader(key)] = row[key];
  return out;
}
function toDateValue(v) {
  let d = null;
  if (v instanceof Date) d = v;
  else if (typeof v === 'string' && v.trim()) {
    const parsed = new Date(v);
    if (!isNaN(parsed)) d = parsed;
  }
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function toNumberValue(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function toTextValue(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// POST /trazabilidad/:entity/import -> sube un Excel/CSV y crea filas nuevas (no reemplaza nada).
// Las columnas del archivo pueden llamarse como el nombre interno del campo o como su etiqueta
// (p.ej. "id_centro" o "Centro" son equivalentes); para select-entity/select-catalogo tambien
// acepta el texto de la etiqueta en vez del id (se resuelve contra la tabla/catalogo referenciado).
router.post('/:entity/import', uploadExcel.single('file'), asyncRoute(async (req, res) => {
  const entity = getEntity(req.params.entity);
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo.' });

  const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  if (rawRows.length === 0) return res.status(400).json({ error: 'El archivo no tiene filas.' });
  const rows = rawRows.map(normalizeRowKeys);

  const lookupMaps = {};
  for (const f of entity.fields) {
    if (f.type === 'select-entity') {
      const refEntity = getEntity(f.entity);
      const labelCol = f.labelField === 'id' ? 'id::text' : f.labelField;
      const result = await pool.query(`SELECT id, ${labelCol} AS label FROM ${refEntity.table}`);
      const map = {};
      result.rows.forEach((r) => { map[normalizeHeader(r.label)] = r.id; });
      lookupMaps[f.name] = map;
    } else if (f.type === 'select-catalogo') {
      const result = await pool.query('SELECT id, descripcion AS label FROM tz_catalogos WHERE categoria = $1', [f.categoria]);
      const map = {};
      result.rows.forEach((r) => { map[normalizeHeader(r.label)] = r.id; });
      lookupMaps[f.name] = map;
    }
  }

  function resolveFieldValue(f, rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') return null;
    if (f.type === 'select-entity' || f.type === 'select-catalogo') {
      if (typeof rawValue === 'number' || /^\d+$/.test(String(rawValue).trim())) return Number(rawValue);
      const map = lookupMaps[f.name] || {};
      return map[normalizeHeader(rawValue)] || null;
    }
    if (f.type === 'date') return toDateValue(rawValue);
    if (f.type === 'number' || f.type === 'decimal') return toNumberValue(rawValue);
    return toTextValue(rawValue);
  }

  const parsedRows = [];
  const errores = [];
  rows.forEach((row, idx) => {
    const parsed = {};
    let missingRequired = null;
    entity.fields.forEach((f) => {
      const byLabel = normalizeHeader(f.label);
      const byName = normalizeHeader(f.name);
      const rawValue = (byLabel in row) ? row[byLabel] : row[byName];
      const value = resolveFieldValue(f, rawValue);
      if (f.required && (value === null || value === undefined)) missingRequired = f.label;
      parsed[f.name] = value;
    });
    if (missingRequired) {
      errores.push('Fila ' + (idx + 2) + ': falta o no se pudo resolver "' + missingRequired + '".');
      return;
    }
    parsedRows.push(parsed);
  });

  if (parsedRows.length === 0) {
    return res.status(400).json({ error: 'Ninguna fila fue válida.', detalles: errores.slice(0, 20) });
  }

  const columns = entity.fields.map((f) => f.name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const chunkSize = 500;
    for (let i = 0; i < parsedRows.length; i += chunkSize) {
      const chunk = parsedRows.slice(i, i + chunkSize);
      const values = [];
      const placeholders = chunk.map((row, cIdx) => {
        const base = cIdx * columns.length;
        columns.forEach((col) => values.push(row[col]));
        return '(' + columns.map((_, k) => '$' + (base + k + 1)).join(',') + ')';
      }).join(',');
      await client.query(`INSERT INTO ${entity.table} (${columns.join(',')}) VALUES ${placeholders}`, values);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await logActivity(req.user.id, 'pruebas_trazabilidad_importado',
    { entity: req.params.entity, filas: parsedRows.length, omitidas: errores.length }, req.ip);
  res.json({ message: 'Importación completa.', importados: parsedRows.length, omitidos: errores.length, detalles: errores.slice(0, 20) });
}));

// GET /trazabilidad/balance-masas-dia?id_reciclador=X&fecha=YYYY-MM-DD -> lo que ya está
// guardado ese día para ese reciclador (una fila por material), para precargar la grilla.
// Registrada ANTES de /:entity para que Express no la confunda con esa ruta genérica.
router.get('/balance-masas-dia', asyncRoute(async (req, res) => {
  const { id_reciclador, fecha } = req.query;
  if (!id_reciclador || !fecha) return res.status(400).json({ error: 'Falta id_reciclador o fecha.' });
  const result = await pool.query(
    `SELECT id, id_tipo_material, cantidad, valor, cantidad_rechazo, cantidad_nosui
     FROM tz_formulario_balance_masas WHERE id_reciclador = $1 AND fecha = $2`,
    [id_reciclador, fecha]
  );
  res.json(result.rows);
}));

// POST /trazabilidad/balance-masas-dia -> guarda de una vez todas las filas de material con
// datos de un reciclador en un día (reemplaza lo que hubiera ese mismo reciclador+fecha),
// igual a como se llena la grilla real: se escribe lo que aplica y se guarda una sola vez.
router.post('/balance-masas-dia', asyncRoute(async (req, res) => {
  const { id_centro, id_reciclador, id_numacro, id_bodega, fecha, materiales } = req.body;
  if (!id_centro || !id_reciclador || !fecha || !Array.isArray(materiales)) {
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tz_formulario_balance_masas WHERE id_reciclador = $1 AND fecha = $2', [id_reciclador, fecha]);
    const filas = materiales.filter((m) => m.cantidad || m.valor || m.cantidad_rechazo || m.cantidad_nosui);
    for (const m of filas) {
      await client.query(
        `INSERT INTO tz_formulario_balance_masas
         (id_centro, id_reciclador, id_tipo_material, id_numacro, id_bodega, fecha, cantidad, valor, cantidad_rechazo, cantidad_nosui)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id_centro, id_reciclador, m.id_tipo_material, id_numacro || null, id_bodega || null, fecha,
          m.cantidad || 0, m.valor || 0, m.cantidad_rechazo || 0, m.cantidad_nosui || 0]
      );
    }
    await client.query('COMMIT');
    await logActivity(req.user.id, 'pruebas_balance_masas_dia_guardado', { id_reciclador, fecha, filas: filas.length }, req.ip);
    res.json({ message: 'Guardado.', filas: filas.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// GET /trazabilidad/:entity/options?labelField=xxx -> opciones {value,label} para un select-entity
router.get('/:entity/options', asyncRoute(async (req, res) => {
  const entity = getEntity(req.params.entity);
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });
  const labelField = req.query.labelField;
  const validCol = entity.fields.some((f) => f.name === labelField) || labelField === 'id';
  if (!validCol) return res.status(400).json({ error: 'Campo de etiqueta inválido.' });
  const result = await pool.query(
    `SELECT id AS value, ${labelField === 'id' ? 'id::text' : labelField} AS label FROM ${entity.table} ORDER BY 2`
  );
  res.json(result.rows);
}));

// GET /trazabilidad/:entity -> lista filas, con las etiquetas de sus select-entity resueltas
router.get('/:entity', asyncRoute(async (req, res) => {
  const entity = getEntity(req.params.entity);
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });

  const selectCols = ['t.id'];
  const joins = [];
  entity.fields.forEach((f, i) => {
    selectCols.push(`t.${f.name}`);
    if (f.type === 'select-entity') {
      const refEntity = getEntity(f.entity);
      const alias = 'j' + i;
      const labelExpr = f.labelField === 'id' ? `${alias}.id::text` : `${alias}.${f.labelField}`;
      selectCols.push(`${labelExpr} AS ${f.name}_label`);
      joins.push(`LEFT JOIN ${refEntity.table} ${alias} ON ${alias}.id = t.${f.name}`);
    } else if (f.type === 'select-catalogo') {
      const alias = 'j' + i;
      selectCols.push(`${alias}.descripcion AS ${f.name}_label`);
      joins.push(`LEFT JOIN tz_catalogos ${alias} ON ${alias}.id = t.${f.name}`);
    }
  });

  const sql = `SELECT ${selectCols.join(', ')} FROM ${entity.table} t ${joins.join(' ')} ORDER BY t.id DESC LIMIT 500`;
  const result = await pool.query(sql);
  res.json(result.rows);
}));

function buildInsertUpdate(entity, body) {
  const cols = [];
  const values = [];
  entity.fields.forEach((f) => {
    if (!(f.name in body)) return;
    let v = body[f.name];
    if (v === '' || v === undefined) v = null;
    cols.push(f.name);
    values.push(v);
  });
  return { cols, values };
}

// POST /trazabilidad/:entity -> crear
router.post('/:entity', asyncRoute(async (req, res) => {
  const entity = getEntity(req.params.entity);
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });

  const missing = entity.fields.filter((f) => f.required && !req.body[f.name]);
  if (missing.length) {
    return res.status(400).json({ error: 'Faltan campos obligatorios: ' + missing.map((f) => f.label).join(', ') });
  }

  const { cols, values } = buildInsertUpdate(entity, req.body);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO ${entity.table} (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING id`;
  const result = await pool.query(sql, values);
  await logActivity(req.user.id, 'pruebas_trazabilidad_creado', { entity: req.params.entity, id: result.rows[0].id }, req.ip);
  res.json({ id: result.rows[0].id });
}));

// PUT /trazabilidad/:entity/:id -> editar
router.put('/:entity/:id', asyncRoute(async (req, res) => {
  const entity = getEntity(req.params.entity);
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });

  const { cols, values } = buildInsertUpdate(entity, req.body);
  if (cols.length === 0) return res.status(400).json({ error: 'Nada para actualizar.' });
  const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  values.push(req.params.id);
  const sql = `UPDATE ${entity.table} SET ${setClause} WHERE id = $${values.length} RETURNING id`;
  const result = await pool.query(sql, values);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Registro no encontrado.' });
  await logActivity(req.user.id, 'pruebas_trazabilidad_editado', { entity: req.params.entity, id: req.params.id }, req.ip);
  res.json({ id: result.rows[0].id });
}));

// DELETE /trazabilidad/:entity/:id
router.delete('/:entity/:id', asyncRoute(async (req, res) => {
  const entity = getEntity(req.params.entity);
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });
  await pool.query(`DELETE FROM ${entity.table} WHERE id = $1`, [req.params.id]);
  await logActivity(req.user.id, 'pruebas_trazabilidad_eliminado', { entity: req.params.entity, id: req.params.id }, req.ip);
  res.json({ message: 'Eliminado.' });
}));

module.exports = router;
