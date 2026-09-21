// Modulo "Pruebas": motor generico de CRUD para las tablas tz_* (trazabilidad nativa).
// En vez de una ruta/pantalla por formulario (como el sistema original en ASP.NET), un
// solo registro de entidades con metadata de campos alimenta tanto el backend genérico
// como el frontend, que arma tablas y formularios dinámicamente a partir de esa metadata.
// Aislado del resto de la app: nunca toca associations/recicladores/mass_balance_entries.
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute, logActivity } = require('../middleware/logger');
const { drawPlanilla, weekBucketRanges, bucketForDay, slugName } = require('../utils/planillaPdf');

const router = express.Router();
router.use(requireAuth, requireRole('pro'));
const uploadExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const ENTITIES = {
  centros: {
    table: 'tz_centros', label: 'Centros (Asociaciones)',
    fields: [
      { name: 'cod_centro', label: 'Código', type: 'text' },
      { name: 'desc_centro', label: 'Nombre', type: 'text', required: true },
      { name: 'nit', label: 'NIT', type: 'text' },
      { name: 'direccion', label: 'Dirección', type: 'text' },
      { name: 'telefono', label: 'Teléfono', type: 'text' },
      { name: 'correo', label: 'Correo', type: 'text' },
      { name: 'rup_numero', label: 'Número RUP', type: 'text' },
      { name: 'rup_fecha_inscripcion', label: 'Fecha inscripción RUP', type: 'date' },
      { name: 'eca_numero', label: 'Número ECA', type: 'text' }
    ]
  },
  areas_prestacion: {
    table: 'tz_areas_prestacion', label: 'Áreas de Prestación (NUAP)',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'cod_departamento_dane', label: 'Departamento (código DANE, 2 dígitos)', type: 'text' },
      { name: 'cod_municipio_dane', label: 'Municipio (código DANE, 3 dígitos)', type: 'text' },
      { name: 'nombre_area', label: 'Nombre del área de prestación', type: 'text', required: true },
      { name: 'fecha_entrada_operacion', label: 'Fecha entrada en operación', type: 'date' },
      { name: 'id_estado', label: 'Estado', type: 'select-catalogo', categoria: 'estado_operacion' },
      { name: 'fecha_estado', label: 'Fecha del estado', type: 'date' }
    ]
  },
  bodegas: {
    table: 'tz_bodegas', label: 'Bodegas (ECA)',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'id_area_prestacion', label: 'Área de prestación (NUAP)', type: 'select-entity', entity: 'areas_prestacion', labelField: 'nombre_area' },
      { name: 'cod_bodega', label: 'Código', type: 'text' },
      { name: 'desc_bodega', label: 'Descripción', type: 'text' },
      { name: 'desc_ubicacion', label: 'Ubicación', type: 'text' },
      { name: 'direccion', label: 'Dirección', type: 'text' },
      { name: 'informacion_complementaria', label: 'Información complementaria del predio', type: 'text' },
      { name: 'longitud', label: 'Longitud (MAGNA-SIRGAS)', type: 'decimal' },
      { name: 'latitud', label: 'Latitud (MAGNA-SIRGAS)', type: 'decimal' },
      { name: 'fecha_inicio_operaciones', label: 'Fecha inicio de operaciones', type: 'date' },
      { name: 'id_propietario_predio', label: 'Propietario del predio', type: 'select-catalogo', categoria: 'propietario_predio' },
      { name: 'id_tipo_contrato', label: 'Tipo de contrato', type: 'select-catalogo', categoria: 'tipo_contrato_predio' },
      { name: 'capacidad_operacion_ton_mes', label: 'Capacidad de operación (Ton/mes)', type: 'decimal' },
      { name: 'capacidad_almacenamiento_m3', label: 'Capacidad de almacenamiento (m³)', type: 'decimal' },
      { name: 'capacidad_almacenamiento_ton', label: 'Capacidad de almacenamiento (Ton)', type: 'decimal' },
      { name: 'id_uso_suelo_compatible', label: '¿Uso del suelo compatible con la actividad?', type: 'select-catalogo', categoria: 'si_no' },
      { name: 'id_uso_suelo', label: 'Uso del suelo del predio', type: 'select-catalogo', categoria: 'uso_suelo_predio' },
      { name: 'id_estado', label: 'Estado', type: 'select-catalogo', categoria: 'estado_operacion' },
      { name: 'fecha_estado', label: 'Fecha del estado', type: 'date' }
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
      { name: 'id_tipo_identificacion', label: 'Tipo de identificación', type: 'select-catalogo', categoria: 'tipos_identificacion', required: true },
      { name: 'nro_documento', label: 'Documento', type: 'text', required: true },
      { name: 'cod_departamento_dane', label: 'Departamento donde opera (código DANE)', type: 'text' },
      { name: 'cod_municipio_dane', label: 'Municipio donde opera (código DANE)', type: 'text' },
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
      { name: 'cantidad_nosui', label: 'Cantidad no SUI', type: 'decimal' },
      { name: 'id_tipo_destino', label: 'Tipo de sitio de destino', type: 'select-catalogo', categoria: 'destinos_rechazo' },
      { name: 'numero_sitio_destino', label: 'Número único del sitio de destino', type: 'text' }
    ]
  },
  macrorrutas: {
    table: 'tz_macrorrutas', label: 'Macrorrutas',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'id_area_prestacion', label: 'Área de prestación (NUAP)', type: 'select-entity', entity: 'areas_prestacion', labelField: 'nombre_area' },
      { name: 'cod_macrorruta', label: 'Código (NUMACRO)', type: 'text' },
      { name: 'desc_macrorruta', label: 'Descripción', type: 'text', required: true },
      { name: 'fecha_inicio_operacion', label: 'Fecha inicio de operación', type: 'date' },
      { name: 'id_estado', label: 'Estado', type: 'select-catalogo', categoria: 'estado_operacion' },
      { name: 'fecha_estado', label: 'Fecha del estado', type: 'date' }
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
      { name: 'id_macrorruta', label: 'Macrorruta (NUMACRO)', type: 'select-entity', entity: 'macrorrutas', labelField: 'desc_macrorruta' },
      { name: 'id_numacro', label: 'Zona interna', type: 'select-entity', entity: 'numacros', labelField: 'cod_numacro' },
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
      { name: 'toneladas', label: 'Toneladas (TAFA)', type: 'decimal' },
      { name: 'dinc_incentivo', label: 'Incentivo DINC a otorgar', type: 'decimal' }
    ]
  },
  recursos: {
    table: 'tz_formulario_recursos', label: 'Recepción de Recursos',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'nuap', label: 'NUAP', type: 'text' },
      { name: 'operador', label: 'ID prestador recolección y transporte RNA', type: 'text' },
      { name: 'periodo_pago', label: 'Periodo del pago', type: 'text' },
      { name: 'valor', label: 'Valor recibido', type: 'decimal' },
      { name: 'fecha', label: 'Fecha de recepción de recursos', type: 'date' }
    ]
  },
  ventas: {
    table: 'tz_formulario_ventas', label: 'Ventas',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'id_bodega', label: 'ECA (NUECA)', type: 'select-entity', entity: 'bodegas', labelField: 'desc_bodega' },
      { name: 'anio', label: 'Año', type: 'number' },
      { name: 'periodo', label: 'Periodo', type: 'text' },
      { name: 'nro_factura', label: 'Número de factura', type: 'text' },
      { name: 'fecha_factura', label: 'Fecha de factura', type: 'date' },
      { name: 'tipo_identificacion', label: 'Tipo identificación comprador', type: 'select-catalogo', categoria: 'tipos_identificacion' },
      { name: 'nro_identificacion', label: 'Nro identificación comprador', type: 'text' },
      { name: 'digito_verificacion', label: 'Dígito de verificación (si NIT)', type: 'text' },
      { name: 'nombre_comprador', label: 'Nombre o razón social del comprador', type: 'text' },
      { name: 'id_entregado_otra_eca', label: '¿Material entregado a otra ECA?', type: 'select-catalogo', categoria: 'si_no' },
      { name: 'material', label: 'Tipo de material (código)', type: 'text' },
      { name: 'kg', label: 'Kilogramos facturados', type: 'decimal' },
      { name: 'toneladas', label: 'Toneladas', type: 'decimal' },
      { name: 'valor_kilo', label: 'Valor por kilo (sin IVA)', type: 'decimal' },
      { name: 'valor_sin_iva', label: 'Subtotal sin IVA', type: 'decimal' },
      { name: 'iva', label: 'IVA', type: 'decimal' },
      { name: 'valor_con_iva', label: 'Total con IVA', type: 'decimal' },
      { name: 'codigo_cufe', label: 'Código CUFE', type: 'text' },
      { name: 'depto_origen', label: 'Departamento origen de residuos', type: 'text' },
      { name: 'municipio_origen', label: 'Municipio origen de residuos', type: 'text' },
      { name: 'id_origen_residuos_usuario', label: 'Origen residuos por usuario', type: 'select-catalogo', categoria: 'origen_residuos_usuario' },
      { name: 'id_origen_residuos_area', label: 'Origen residuos por área', type: 'select-catalogo', categoria: 'origen_residuos_area' },
      { name: 'id_aplica_decreto_596', label: '¿Aplica Decreto 596 de 2016?', type: 'select-catalogo', categoria: 'si_no' },
      { name: 'fecha_habilitacion', label: 'Fecha habilitación (interno)', type: 'date' },
      { name: 'fecha_certificacion', label: 'Fecha certificación (interno)', type: 'date' }
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

// GET /trazabilidad/:entity/template -> plantilla .xlsx con 2 hojas: "Plantilla" (encabezados +
// una fila de ejemplo, lista para llenar y volver a importar) e "Instrucciones" (que va en cada
// columna, en qué formato, y para los campos por código/catálogo, cuáles son los valores válidos).
router.get('/:entity/template', asyncRoute(async (req, res) => {
  const entity = getEntity(req.params.entity);
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });

  const headers = entity.fields.map((f) => f.label);
  const exampleRow = {};
  const instructions = [['Columna', 'Obligatorio', 'Tipo de dato', 'Formato / valores permitidos']];

  for (const f of entity.fields) {
    let formato = '';
    let ejemplo = '';
    if (f.type === 'text') {
      formato = 'Texto libre.';
      ejemplo = 'Texto de ejemplo';
    } else if (f.type === 'number') {
      formato = 'Número entero.';
      ejemplo = '1';
    } else if (f.type === 'decimal') {
      formato = 'Número decimal, usa punto (no coma). Ejemplo: 12.5';
      ejemplo = '12.5';
    } else if (f.type === 'date') {
      formato = 'Fecha en formato AAAA-MM-DD. Ejemplo: 2026-01-31';
      ejemplo = '2026-01-31';
    } else if (f.type === 'select-entity') {
      const refEntity = getEntity(f.entity);
      const labelCol = f.labelField === 'id' ? 'id::text' : f.labelField;
      const sample = await pool.query(`SELECT ${labelCol} AS label FROM ${refEntity.table} ORDER BY 1 LIMIT 5`);
      const nombres = sample.rows.map((r) => r.label).filter(Boolean);
      formato = 'Escribe el nombre exacto de "' + refEntity.label + '" (como aparece en ese módulo), o su número de ID.' +
        (nombres.length ? ' Ejemplos ya cargados: ' + nombres.join(', ') + '.' : '');
      ejemplo = nombres[0] || '';
    } else if (f.type === 'select-catalogo') {
      const options = await pool.query(
        'SELECT descripcion FROM tz_catalogos WHERE categoria = $1 ORDER BY orden, descripcion',
        [f.categoria]
      );
      const valores = options.rows.map((r) => r.descripcion);
      formato = 'Debe ser uno de estos valores exactos: ' + valores.join(' | ') + '.';
      ejemplo = valores[0] || '';
    }
    exampleRow[f.label] = ejemplo;
    instructions.push([f.label, f.required ? 'Sí' : 'No', f.type, formato]);
  }

  const wb = XLSX.utils.book_new();
  const wsPlantilla = XLSX.utils.json_to_sheet([exampleRow], { header: headers });
  wsPlantilla['!cols'] = headers.map(() => ({ wch: 28 }));
  XLSX.utils.book_append_sheet(wb, wsPlantilla, 'Plantilla');

  const wsInstrucciones = XLSX.utils.aoa_to_sheet(instructions);
  wsInstrucciones['!cols'] = [{ wch: 26 }, { wch: 12 }, { wch: 16 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, wsInstrucciones, 'Instrucciones');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_' + req.params.entity + '.xlsx"');
  res.send(buffer);
}));

// GET /trazabilidad/balance-masas-dia?id_reciclador=X&fecha=YYYY-MM-DD -> lo que ya está
// guardado ese día para ese reciclador (una fila por material), para precargar la grilla.
// Registrada ANTES de /:entity para que Express no la confunda con esa ruta genérica.
router.get('/balance-masas-dia', asyncRoute(async (req, res) => {
  const { id_reciclador, fecha } = req.query;
  if (!id_reciclador || !fecha) return res.status(400).json({ error: 'Falta id_reciclador o fecha.' });
  const result = await pool.query(
    `SELECT id, id_tipo_material, cantidad, valor, cantidad_rechazo, cantidad_nosui, id_tipo_destino, numero_sitio_destino,
            id_bodega, id_macrorruta, id_microrruta_1, id_microrruta_2
     FROM tz_formulario_balance_masas WHERE id_reciclador = $1 AND fecha = $2`,
    [id_reciclador, fecha]
  );
  res.json(result.rows);
}));

// POST /trazabilidad/balance-masas-dia -> guarda de una vez todas las filas de material con
// datos de un reciclador en un día (reemplaza lo que hubiera ese mismo reciclador+fecha),
// igual a como se llena la grilla real: se escribe lo que aplica y se guarda una sola vez.
// id_tipo_destino/numero_sitio_destino son por material (el rechazo de cada material puede ir
// a un sitio de destino distinto), tal como lo exige el formato real de Balance de Masas.
router.post('/balance-masas-dia', asyncRoute(async (req, res) => {
  const { id_centro, id_reciclador, id_numacro, id_bodega, id_macrorruta, id_microrruta_1, id_microrruta_2, fecha, materiales } = req.body;
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
         (id_centro, id_reciclador, id_tipo_material, id_numacro, id_bodega, id_macrorruta, id_microrruta_1, id_microrruta_2, fecha, cantidad, valor, cantidad_rechazo, cantidad_nosui, id_tipo_destino, numero_sitio_destino)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id_centro, id_reciclador, m.id_tipo_material, id_numacro || null, id_bodega || null, id_macrorruta || null,
          id_microrruta_1 || null, id_microrruta_2 || null, fecha,
          m.cantidad || 0, m.valor || 0, m.cantidad_rechazo || 0, m.cantidad_nosui || 0,
          m.id_tipo_destino || null, m.numero_sitio_destino || null]
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

// GET /trazabilidad/balance-masas-export?desde=&hasta=&id_centro= -> todas las filas de balance
// de masas en ese rango de fechas (sin el limite de 500 del listado generico), con las columnas
// ya resueltas (reciclador, material, bodega, numacro, centro) para armar el reporte periodico
// en el mismo formato que recibe la Superintendencia. Registrada antes de /:entity.
router.get('/balance-masas-export', asyncRoute(async (req, res) => {
  const { desde, hasta, id_centro } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: 'Falta el rango de fechas (desde y hasta).' });
  const params = [desde, hasta];
  let where = 'bm.fecha BETWEEN $1 AND $2';
  if (id_centro) {
    params.push(id_centro);
    where += ' AND bm.id_centro = $' + params.length;
  }
  const result = await pool.query(
    `SELECT bm.fecha, bm.cantidad, bm.valor, bm.cantidad_rechazo, bm.cantidad_nosui,
            bm.numero_sitio_destino,
            c.desc_centro AS centro,
            b.cod_bodega, b.desc_bodega,
            m.cod_macrorruta,
            r.nro_documento, r.nombre_completo, r.placa,
            tid.codigo AS codigo_tipo_identificacion,
            tm.cod_tipo_material, tm.desc_tipo_material,
            tdes.codigo AS codigo_tipo_destino
     FROM tz_formulario_balance_masas bm
     LEFT JOIN tz_centros c ON c.id = bm.id_centro
     LEFT JOIN tz_bodegas b ON b.id = bm.id_bodega
     LEFT JOIN tz_macrorrutas m ON m.id = bm.id_macrorruta
     LEFT JOIN tz_recicladores r ON r.id = bm.id_reciclador
     LEFT JOIN tz_catalogos tid ON tid.id = r.id_tipo_identificacion
     LEFT JOIN tz_tipos_material tm ON tm.id = bm.id_tipo_material
     LEFT JOIN tz_catalogos tdes ON tdes.id = bm.id_tipo_destino
     WHERE ${where}
     ORDER BY bm.fecha, r.nombre_completo`,
    params
  );
  res.json(result.rows);
}));

// GET /trazabilidad/planillas-recepcion?anio=&mes=&id_centro=[&id_reciclador=] -> planilla(s)
// mensual(es) de recepcion de material por reciclador (comprobante de lo entregado esa semana,
// agrupado en 4 bloques dentro del mes), en el mismo formato que ya se usaba en la asociacion.
// Sin id_reciclador devuelve un .zip con una planilla por cada reciclador que tuvo entregas ese
// mes; con id_reciclador devuelve un solo PDF. Registrada antes de /:entity.
router.get('/planillas-recepcion', asyncRoute(async (req, res) => {
  const { anio, mes, id_centro, id_reciclador } = req.query;
  if (!anio || !mes || !id_centro) return res.status(400).json({ error: 'Falta anio, mes o id_centro.' });
  const anioNum = Number(anio);
  const mesNum = Number(mes);
  if (!anioNum || !mesNum || mesNum < 1 || mesNum > 12) return res.status(400).json({ error: 'Mes o año inválido.' });

  const centroRes = await pool.query('SELECT desc_centro, nit, direccion, telefono, correo FROM tz_centros WHERE id = $1', [id_centro]);
  if (centroRes.rows.length === 0) return res.status(404).json({ error: 'Centro no encontrado.' });
  const centro = centroRes.rows[0];

  const desde = `${anio}-${String(mesNum).padStart(2, '0')}-01`;
  const lastDay = new Date(anioNum, mesNum, 0).getDate();
  const hasta = `${anio}-${String(mesNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const params = [id_centro, desde, hasta];
  let recFilter = '';
  if (id_reciclador) {
    params.push(id_reciclador);
    recFilter = ' AND bm.id_reciclador = $4';
  }

  const rowsRes = await pool.query(
    `SELECT bm.fecha, bm.cantidad, bm.id_reciclador,
            r.nombre_completo, r.nro_documento, r.tipo_de_vehiculo, r.placa,
            b.desc_bodega, mr.cod_macrorruta,
            tm.desc_tipo_material, tm.secuencia_orden
     FROM tz_formulario_balance_masas bm
     JOIN tz_recicladores r ON r.id = bm.id_reciclador
     LEFT JOIN tz_bodegas b ON b.id = bm.id_bodega
     LEFT JOIN tz_macrorrutas mr ON mr.id = bm.id_macrorruta
     LEFT JOIN tz_tipos_material tm ON tm.id = bm.id_tipo_material
     WHERE bm.id_centro = $1 AND bm.fecha BETWEEN $2 AND $3${recFilter}
     ORDER BY r.nombre_completo, tm.secuencia_orden`,
    params
  );
  if (rowsRes.rows.length === 0) return res.status(404).json({ error: 'No hay datos de balance de masas para ese periodo.' });

  const ranges = weekBucketRanges(anioNum, mesNum);
  const porReciclador = new Map();
  for (const r of rowsRes.rows) {
    if (!porReciclador.has(r.id_reciclador)) {
      porReciclador.set(r.id_reciclador, { reciclador: r, materiales: new Map(), bodega: r.desc_bodega, macrorruta: r.cod_macrorruta });
    }
    const entry = porReciclador.get(r.id_reciclador);
    const matKey = r.desc_tipo_material || 'Sin material';
    if (!entry.materiales.has(matKey)) entry.materiales.set(matKey, [0, 0, 0, 0]);
    const dia = Number(String(r.fecha).slice(8, 10));
    entry.materiales.get(matKey)[bucketForDay(dia, ranges)] += Number(r.cantidad);
  }

  const periodoLabel = `${desde} a ${hasta}`;
  function buildData(entry) {
    const materiales = [...entry.materiales.entries()].map(([nombre, vals]) => ({ nombre, vals, total: vals.reduce((a, b) => a + b, 0) }));
    const totalPorSemana = [0, 0, 0, 0];
    materiales.forEach((m) => m.vals.forEach((v, i) => { totalPorSemana[i] += v; }));
    const totalPeriodo = totalPorSemana.reduce((a, b) => a + b, 0);
    return { centro, reciclador: entry.reciclador, bodega: entry.bodega, macrorruta: entry.macrorruta, periodoLabel, ranges, materiales, totalPorSemana, totalPeriodo };
  }

  await logActivity(req.user.id, 'pruebas_planillas_generadas', { id_centro, anio: anioNum, mes: mesNum, id_reciclador: id_reciclador || null, recicladores: porReciclador.size }, req.ip);

  if (id_reciclador) {
    const entry = [...porReciclador.values()][0];
    if (!entry) return res.status(404).json({ error: 'No hay datos para ese reciclador en el periodo.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="planilla_${entry.reciclador.nro_documento}_${slugName(entry.reciclador.nombre_completo)}.pdf"`);
    const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
    doc.pipe(res);
    drawPlanilla(doc, buildData(entry));
    doc.end();
    return;
  }

  const mesesLargo = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Planillas_Recepcion_${mesesLargo[mesNum - 1]}${anio}.zip"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  for (const entry of porReciclador.values()) {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => doc.on('end', resolve));
    drawPlanilla(doc, buildData(entry));
    doc.end();
    await done;
    archive.append(Buffer.concat(chunks), { name: `Planillas_Individuales/planilla_${entry.reciclador.nro_documento}_${slugName(entry.reciclador.nombre_completo)}.pdf` });
  }
  await archive.finalize();
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
