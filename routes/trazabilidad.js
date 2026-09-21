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

const { validateRecord, newContext, mapDbError, todayCO, isValidYmd, CROSS } = require('../utils/trazaValidate');

const router = express.Router();
router.use(requireAuth, requireRole('pro'));
const uploadExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Listas fijas (terminos que el usuario no debe escribir a mano). value se guarda tal cual.
const opt = (...values) => values.map((v) => ({ value: v, label: v }));
const OPCIONES = {
  estadoActivo: opt('Activo', 'Inactivo'),
  estadoRuta: opt('Activa', 'Suspendida', 'Inactiva'),
  vehiculo: opt('Carreta', 'Triciclo', 'Bicicleta', 'Zorra de traccion humana', 'Vehiculo de traccion animal', 'Moto', 'Camioneta', 'Camion', 'Ninguno'),
  fase: opt('Pendiente', 'En proceso', 'Completada'),
  pqrTipo: opt('Peticion', 'Queja', 'Reclamo'),
  pqrEstado: opt('Abierta', 'En proceso', 'Cerrada'),
  afiliacion: opt('Afiliado', 'Sin afiliar', 'En tramite'),
  siNo: [{ value: 'true', label: 'Sí' }, { value: 'false', label: 'No' }],
  barrido: opt('Manual', 'Mecanico')
};

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
      { name: 'eca_numero', label: 'Número ECA', type: 'text' },
      { name: 'id_tipo_destino', label: 'Destino del rechazo: tipo de sitio (fijo)', type: 'select-catalogo', categoria: 'destinos_rechazo' },
      { name: 'numero_sitio_destino', label: 'Destino del rechazo: número único del sitio (fijo)', type: 'text' }
    ]
  },
  catalogos: {
    table: 'tz_catalogos', label: 'Códigos y términos fijos',
    fields: [
      { name: 'categoria', label: 'Lista (categoría)', type: 'text', required: true },
      { name: 'codigo', label: 'Código', type: 'text', required: true },
      { name: 'descripcion', label: 'Descripción', type: 'text', required: true },
      { name: 'grupo', label: 'Grupo', type: 'text' },
      { name: 'orden', label: 'Orden', type: 'number' }
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
      { name: 'estado', label: 'Estado', type: 'select-fixed', options: OPCIONES.estadoActivo },
      { name: 'fecha_exp_documento', label: 'Fecha expedición doc.', type: 'date' },
      { name: 'fecha_nacimiento', label: 'Fecha nacimiento', type: 'date' },
      { name: 'direccion', label: 'Dirección', type: 'text' },
      { name: 'telefono', label: 'Teléfono', type: 'text' },
      { name: 'tipo_de_vehiculo', label: 'Tipo vehículo', type: 'select-fixed', options: OPCIONES.vehiculo },
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
      { name: 'estado', label: 'Estado', type: 'select-fixed', options: OPCIONES.fase },
      { name: 'fecha_completada', label: 'Fecha completada', type: 'date' },
      { name: 'observaciones', label: 'Observaciones', type: 'text' }
    ]
  },
  pqr: {
    table: 'tz_pqr', label: 'PQR',
    fields: [
      { name: 'id_centro', label: 'Centro', type: 'select-entity', entity: 'centros', labelField: 'desc_centro', required: true },
      { name: 'tipo', label: 'Tipo', type: 'select-fixed', options: OPCIONES.pqrTipo },
      { name: 'fecha', label: 'Fecha', type: 'date' },
      { name: 'nombre_solicitante', label: 'Nombre solicitante', type: 'text' },
      { name: 'documento_solicitante', label: 'Documento solicitante', type: 'text' },
      { name: 'descripcion', label: 'Descripción', type: 'text' },
      { name: 'estado', label: 'Estado', type: 'select-fixed', options: OPCIONES.pqrEstado },
      { name: 'fecha_respuesta', label: 'Fecha respuesta', type: 'date' },
      { name: 'respuesta', label: 'Respuesta', type: 'text' }
    ]
  },
  seguridad_social: {
    table: 'tz_seguridad_social', label: 'Seguridad Social (Decreto 271/2026)',
    fields: [
      { name: 'id_reciclador', label: 'Reciclador', type: 'select-entity', entity: 'recicladores', labelField: 'nombre_completo', required: true },
      { name: 'eps', label: 'EPS', type: 'text' },
      { name: 'estado_afiliacion_eps', label: 'Estado afiliación EPS', type: 'select-fixed', options: OPCIONES.afiliacion },
      { name: 'arl', label: 'ARL', type: 'text' },
      { name: 'estado_afiliacion_arl', label: 'Estado afiliación ARL', type: 'select-fixed', options: OPCIONES.afiliacion },
      { name: 'base_cotizacion_arl', label: 'Base cotización ARL', type: 'decimal' },
      { name: 'beps_afiliado', label: 'Afiliado a BEPS', type: 'select-fixed', options: OPCIONES.siNo },
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
      { name: 'estado', label: 'Estado', type: 'select-fixed', options: OPCIONES.estadoRuta }
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
      { name: 'tipo_barrido', label: 'Tipo barrido', type: 'select-fixed', options: OPCIONES.barrido }
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
      { name: 'id_tipo_identificacion', label: 'Tipo identificación comprador', type: 'select-catalogo', categoria: 'tipos_identificacion' },
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
  // hasOwnProperty: sin esto, "constructor" o "__proto__" en la URL devolvian un objeto de JS.
  if (!Object.prototype.hasOwnProperty.call(ENTITIES, key)) return null;
  return ENTITIES[key];
}

// Igual que asyncRoute, pero los errores de restriccion de PostgreSQL (duplicado, texto muy
// largo, referencia rota...) se contestan como 4xx con un mensaje claro en vez de un 500.
function guard(fn) {
  return asyncRoute(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      const mapped = mapDbError(err);
      if (mapped && !res.headersSent) return res.status(mapped.status).json({ error: mapped.error });
      throw err;
    }
  });
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
router.get('/catalogo-options/:categoria', guard(async (req, res) => {
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
// Devuelve 'YYYY-MM-DD' o null si no se pudo entender. Un texto con barras/puntos se lee en el
// orden colombiano DIA/MES/AÑO (new Date('03/04/2026') lo leeria como 4 de marzo, en gringo).
function toDateValue(v) {
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else return null;
  const out = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isValidYmd(out) ? out : null;
}
// Numero desde Excel/CSV: acepta 12.5, 12,5 y 1.234,56. Devuelve null si no es un numero.
function toNumberValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/\s/g, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
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
router.post('/:entity/import', uploadExcel.single('file'), guard(async (req, res) => {
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

  // Convierte la celda al tipo del campo. Si tiene contenido pero no se entiende, se devuelve
  // {error} (antes se convertia en NULL en silencio y el dato se perdia sin avisar).
  function resolveFieldValue(f, rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') return { value: null };
    if (f.type === 'select-entity' || f.type === 'select-catalogo') {
      if (typeof rawValue === 'number' || /^\d+$/.test(String(rawValue).trim())) return { value: Number(rawValue) };
      const id = (lookupMaps[f.name] || {})[normalizeHeader(rawValue)];
      return id ? { value: id } : { error: `"${f.label}": "${rawValue}" no existe en ese módulo.` };
    }
    if (f.type === 'date') {
      const d = toDateValue(rawValue);
      return d ? { value: d } : { error: `"${f.label}": la fecha "${rawValue}" no se entiende (usa AAAA-MM-DD o DD/MM/AAAA).` };
    }
    if (f.type === 'number' || f.type === 'decimal') {
      const n = toNumberValue(rawValue);
      return n !== null ? { value: n } : { error: `"${f.label}": "${rawValue}" no es un número.` };
    }
    return { value: toTextValue(rawValue) };
  }

  const parsedRows = [];
  const errores = [];
  let omitidas = 0;
  const ctx = newContext(true);
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const parsed = {};
    const rowErrors = [];
    entity.fields.forEach((f) => {
      const byLabel = normalizeHeader(f.label);
      const byName = normalizeHeader(f.name);
      const rawValue = (byLabel in row) ? row[byLabel] : row[byName];
      const r = resolveFieldValue(f, rawValue);
      if (r.error) rowErrors.push(r.error); else parsed[f.name] = r.value;
    });
    if (rowErrors.length === 0) {
      const v = await validateRecord(ENTITIES, req.params.entity, parsed, { ctx });
      if (v.errors.length) rowErrors.push(...v.errors);
      else Object.assign(parsed, v.values);
    }
    if (rowErrors.length) {
      omitidas++;
      if (errores.length < 20) errores.push('Fila ' + (idx + 2) + ': ' + rowErrors.join(' '));
      continue;
    }
    parsedRows.push(parsed);
  }

  if (parsedRows.length === 0) {
    return res.status(400).json({ error: 'Ninguna fila fue válida.' + (errores[0] ? ' ' + errores[0] : ''), detalles: errores });
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
    { entity: req.params.entity, filas: parsedRows.length, omitidas }, req.ip);
  res.json({ message: 'Importación completa.', importados: parsedRows.length, omitidos: omitidas, detalles: errores });
}));

// GET /trazabilidad/:entity/template -> plantilla .xlsx con 2 hojas: "Plantilla" (encabezados +
// una fila de ejemplo, lista para llenar y volver a importar) e "Instrucciones" (que va en cada
// columna, en qué formato, y para los campos por código/catálogo, cuáles son los valores válidos).
router.get('/:entity/template', guard(async (req, res) => {
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
    } else if (f.type === 'select-fixed') {
      formato = 'Debe ser uno de estos valores: ' + f.options.map((o) => o.label).join(' | ') + '.';
      ejemplo = f.options[0].label;
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
router.get('/balance-masas-dia', guard(async (req, res) => {
  const idReciclador = parseId(req.query.id_reciclador);
  if (!idReciclador || !isValidYmd(req.query.fecha)) return res.status(400).json({ error: 'Falta id_reciclador o la fecha no es válida.' });
  const result = await pool.query(
    `SELECT id, id_tipo_material, cantidad, valor, cantidad_rechazo, cantidad_nosui,
            id_bodega, id_macrorruta, id_microrruta_1, id_microrruta_2
     FROM tz_formulario_balance_masas WHERE id_reciclador = $1 AND fecha = $2`,
    [idReciclador, req.query.fecha]
  );
  res.json(result.rows);
}));

const BM_MAX = 99999999;

// Valida todo el dia antes de tocar la base: fecha, reciclador del centro, bodega/macrorruta/
// microrrutas del mismo centro, materiales existentes y sin repetir, numeros >= 0, y que el
// rechazo y la cantidad no SUI nunca superen la cantidad del material. Devuelve {errors} o {data}.
async function validateBalanceDia(body) {
  const errors = [];
  const b = body || {};
  const idCentro = parseId(b.id_centro);
  const idReciclador = parseId(b.id_reciclador);
  if (!idCentro || !idReciclador || !Array.isArray(b.materiales)) return { errors: ['Faltan datos obligatorios.'] };
  if (!isValidYmd(b.fecha)) return { errors: ['La fecha no es válida.'] };
  if (b.fecha > todayCO()) return { errors: ['No se puede registrar material con fecha futura.'] };
  if (b.fecha < '2000-01-01') return { errors: ['La fecha es demasiado antigua.'] };

  const rec = await pool.query('SELECT id_centro FROM tz_recicladores WHERE id = $1', [idReciclador]);
  if (!rec.rows[0]) return { errors: ['El reciclador no existe.'] };
  if (rec.rows[0].id_centro !== idCentro) return { errors: ['El reciclador no pertenece a ese centro.'] };

  const opcionales = {};
  for (const k of ['id_numacro', 'id_bodega', 'id_macrorruta', 'id_microrruta_1', 'id_microrruta_2']) {
    if (b[k] === undefined || b[k] === null || b[k] === '') { opcionales[k] = null; continue; }
    const n = parseId(b[k]);
    if (!n) return { errors: ['Alguno de los selectores (ECA, macrorruta, microrruta) es inválido.'] };
    opcionales[k] = n;
  }
  const mismoCentro = async (table, id, label) => {
    if (!id) return;
    const r = await pool.query(`SELECT id_centro FROM ${table} WHERE id = $1`, [id]);
    if (!r.rows[0]) errors.push(`${label}: no existe.`);
    else if (r.rows[0].id_centro !== idCentro) errors.push(`${label}: pertenece a otro centro.`);
  };
  await mismoCentro('tz_numacros', opcionales.id_numacro, 'Zona');
  await mismoCentro('tz_bodegas', opcionales.id_bodega, 'ECA (NUECA)');
  await mismoCentro('tz_macrorrutas', opcionales.id_macrorruta, 'Macrorruta (NUMACRO)');
  for (const k of ['id_microrruta_1', 'id_microrruta_2']) {
    if (!opcionales[k]) continue;
    const r = await pool.query(
      `SELECT f.id_centro, f.id_reciclador FROM tz_formulario_microrrutas_detalle d
       JOIN tz_formulario_microrrutas f ON f.id = d.id_formulario_microrruta WHERE d.id = $1`, [opcionales[k]]);
    const label = k === 'id_microrruta_1' ? 'Microrruta 1' : 'Microrruta 2';
    if (!r.rows[0]) errors.push(`${label}: no existe.`);
    else if (r.rows[0].id_centro !== idCentro || (r.rows[0].id_reciclador && r.rows[0].id_reciclador !== idReciclador)) {
      errors.push(`${label}: no corresponde a este reciclador.`);
    }
  }
  if (opcionales.id_microrruta_1 && opcionales.id_microrruta_1 === opcionales.id_microrruta_2) {
    errors.push('Microrruta 1 y Microrruta 2 no pueden ser la misma.');
  }

  const ids = b.materiales.map((m) => parseId(m && m.id_tipo_material));
  if (ids.some((x) => !x)) errors.push('Hay un material inválido en la lista.');
  const validIds = ids.filter(Boolean);
  if (new Set(validIds).size !== validIds.length) errors.push('Hay un material repetido en la lista.');
  const names = new Map();
  if (validIds.length) {
    const r = await pool.query('SELECT id, desc_tipo_material FROM tz_tipos_material WHERE id = ANY($1::int[])', [validIds]);
    r.rows.forEach((x) => names.set(x.id, x.desc_tipo_material));
  }

  const filas = [];
  b.materiales.forEach((m) => {
    const id = parseId(m && m.id_tipo_material);
    if (!id) return;
    const name = names.get(id) || ('#' + id);
    if (!names.has(id)) { errors.push(`El material ${name} no existe.`); return; }
    const num = (v, label) => {
      if (v === undefined || v === null || v === '') return 0;
      const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > BM_MAX) { errors.push(`${name}: "${label}" debe ser un número entre 0 y ${BM_MAX}.`); return 0; }
      return n;
    };
    const row = { id_tipo_material: id, cantidad: num(m.cantidad, 'Cantidad'), valor: num(m.valor, 'Valor'),
      cantidad_rechazo: num(m.cantidad_rechazo, 'Cantidad rechazo'), cantidad_nosui: num(m.cantidad_nosui, 'Cantidad no SUI') };
    if (!(row.cantidad || row.valor || row.cantidad_rechazo || row.cantidad_nosui)) return; // fila vacia de la grilla
    const rowErrors = [];
    CROSS.balance_masas(row, rowErrors);
    rowErrors.forEach((e) => errors.push(`${name}: ${e}`));
    filas.push(row);
  });

  return { errors, data: { idCentro, idReciclador, fecha: b.fecha, opcionales, filas } };
}

// POST /trazabilidad/balance-masas-dia -> guarda de una vez todas las filas de material con
// datos de un reciclador en un día (reemplaza lo que hubiera ese mismo reciclador+fecha),
// igual a como se llena la grilla real: se escribe lo que aplica y se guarda una sola vez.
// El sitio de destino del rechazo NO se captura aquí: es un valor fijo de la asociación
// (tz_centros.id_tipo_destino / numero_sitio_destino, lo configura el administrador) y el
// export a la Super lo toma de ahí.
router.post('/balance-masas-dia', guard(async (req, res) => {
  const v = await validateBalanceDia(req.body);
  if (v.errors.length) return sendValidationErrors(res, v.errors);
  const { idCentro, idReciclador, fecha, opcionales, filas } = v.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tz_formulario_balance_masas WHERE id_reciclador = $1 AND fecha = $2', [idReciclador, fecha]);
    for (const m of filas) {
      await client.query(
        `INSERT INTO tz_formulario_balance_masas
         (id_centro, id_reciclador, id_tipo_material, id_numacro, id_bodega, id_macrorruta, id_microrruta_1, id_microrruta_2, fecha, cantidad, valor, cantidad_rechazo, cantidad_nosui)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [idCentro, idReciclador, m.id_tipo_material, opcionales.id_numacro, opcionales.id_bodega, opcionales.id_macrorruta,
          opcionales.id_microrruta_1, opcionales.id_microrruta_2, fecha,
          m.cantidad, m.valor, m.cantidad_rechazo, m.cantidad_nosui]
      );
    }
    await client.query('COMMIT');
    await logActivity(req.user.id, 'pruebas_balance_masas_dia_guardado', { id_reciclador: idReciclador, fecha, filas: filas.length }, req.ip);
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
router.get('/balance-masas-export', guard(async (req, res) => {
  const { desde, hasta, id_centro } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: 'Falta el rango de fechas (desde y hasta).' });
  if (!isValidYmd(desde) || !isValidYmd(hasta)) return res.status(400).json({ error: 'Las fechas no son válidas.' });
  if (desde > hasta) return res.status(400).json({ error: 'La fecha "desde" no puede ser posterior a "hasta".' });
  const params = [desde, hasta];
  let where = 'bm.fecha BETWEEN $1 AND $2';
  if (id_centro) {
    const idc = parseId(id_centro);
    if (!idc) return res.status(400).json({ error: 'id_centro inválido.' });
    params.push(idc);
    where += ' AND bm.id_centro = $' + params.length;
  }
  const result = await pool.query(
    `SELECT bm.fecha, bm.cantidad, bm.valor, bm.cantidad_rechazo, bm.cantidad_nosui,
            COALESCE(NULLIF(bm.numero_sitio_destino, ''), c.numero_sitio_destino) AS numero_sitio_destino,
            c.desc_centro AS centro,
            b.cod_bodega, b.desc_bodega,
            m.cod_macrorruta,
            r.nro_documento, r.nombre_completo, r.placa,
            tid.codigo AS codigo_tipo_identificacion,
            tm.cod_tipo_material, tm.desc_tipo_material,
            COALESCE(tdes.codigo, cdes.codigo) AS codigo_tipo_destino
     FROM tz_formulario_balance_masas bm
     LEFT JOIN tz_centros c ON c.id = bm.id_centro
     LEFT JOIN tz_catalogos cdes ON cdes.id = c.id_tipo_destino
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

// El logo vive en la asociacion real (tabla associations, lo sube el administrador). Un centro de
// este sandbox lo toma por el NIT: se comparan solo los digitos y se ignora el digito de
// verificacion (los primeros 9), porque el mismo NIT se escribe como 901494752-8 o 901.494.752.
function nitBase(nit) { return String(nit || '').replace(/\D/g, '').slice(0, 9); }

async function findLogoUrlByNit(nit) {
  const base = nitBase(nit);
  if (base.length < 6) return null;
  const r = await pool.query(
    `SELECT logo_url FROM associations
     WHERE logo_url IS NOT NULL AND left(regexp_replace(COALESCE(nit, ''), '\\D', '', 'g'), 9) = $1 LIMIT 1`,
    [base]
  );
  return r.rows[0] ? r.rows[0].logo_url : null;
}

async function fetchImageBuffer(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    return null;
  }
}

// GET /trazabilidad/centro-logo/:id -> {logo_url} del centro (por NIT), para las impresiones.
router.get('/centro-logo/:id', guard(async (req, res) => {
  const c = await pool.query('SELECT nit FROM tz_centros WHERE id = $1', [req.params.id]);
  res.json({ logo_url: c.rows[0] ? await findLogoUrlByNit(c.rows[0].nit) : null });
}));

// GET /trazabilidad/planillas-recepcion?anio=&mes=&id_centro=[&id_reciclador=] -> planilla(s)
// mensual(es) de recepcion de material por reciclador (comprobante de lo entregado esa semana,
// agrupado en 4 bloques dentro del mes), en el mismo formato que ya se usaba en la asociacion.
// Sin id_reciclador devuelve un .zip con una planilla por cada reciclador que tuvo entregas ese
// mes; con id_reciclador devuelve un solo PDF. Registrada antes de /:entity.
router.get('/planillas-recepcion', guard(async (req, res) => {
  const { anio, mes, id_centro, id_reciclador } = req.query;
  if (!anio || !mes || !id_centro) return res.status(400).json({ error: 'Falta anio, mes o id_centro.' });
  const anioNum = Number(anio);
  const mesNum = Number(mes);
  if (!Number.isInteger(anioNum) || !Number.isInteger(mesNum) || anioNum < 2000 || anioNum > 2100 || mesNum < 1 || mesNum > 12) {
    return res.status(400).json({ error: 'Mes o año inválido.' });
  }
  if (!parseId(id_centro) || (id_reciclador && !parseId(id_reciclador))) return res.status(400).json({ error: 'Centro o reciclador inválido.' });

  const centroRes = await pool.query('SELECT desc_centro, nit, direccion, telefono, correo FROM tz_centros WHERE id = $1', [id_centro]);
  if (centroRes.rows.length === 0) return res.status(404).json({ error: 'Centro no encontrado.' });
  const centro = centroRes.rows[0];
  const logoUrl = await findLogoUrlByNit(centro.nit);
  centro.logoBuffer = logoUrl ? await fetchImageBuffer(logoUrl) : null;

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
router.get('/:entity/options', guard(async (req, res) => {
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
router.get('/:entity', guard(async (req, res) => {
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

  // ?id_centro=X limita a los datos de ese centro EN LA BASE (el filtro del navegador, despues del
  // LIMIT, dejaba fuera los datos de una asociacion cuando otras tenian mas de 500 filas).
  const params = [];
  let where = '';
  if (req.query.id_centro !== undefined && req.query.id_centro !== '') {
    const idc = Number(req.query.id_centro);
    if (!Number.isInteger(idc) || idc <= 0) return res.status(400).json({ error: 'id_centro inválido.' });
    const cond = centroCondition(req.params.entity, entity);
    if (cond) { params.push(idc); where = 'WHERE ' + cond; }
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 5000);
  const sql = `SELECT ${selectCols.join(', ')} FROM ${entity.table} t ${joins.join(' ')} ${where} ORDER BY t.id DESC LIMIT ${limit}`;
  const result = await pool.query(sql, params);
  res.json(result.rows);
}));

// Condicion SQL ($1 = id del centro) que acota una entidad a un centro, o null si no depende de uno.
function centroCondition(key, entity) {
  if (key === 'centros') return 't.id = $1';
  if (entity.fields.some((f) => f.name === 'id_centro')) return 't.id_centro = $1';
  if (key === 'seguridad_social') return 't.id_reciclador IN (SELECT id FROM tz_recicladores WHERE id_centro = $1)';
  if (key === 'microrrutas_detalle') return 't.id_formulario_microrruta IN (SELECT id FROM tz_formulario_microrrutas WHERE id_centro = $1)';
  return null;
}

function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sendValidationErrors(res, errors) {
  res.status(400).json({ error: errors.slice(0, 3).join(' '), detalles: errors });
}

// POST /trazabilidad/:entity -> crear
router.post('/:entity', guard(async (req, res) => {
  const entity = getEntity(req.params.entity);
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });

  const v = await validateRecord(ENTITIES, req.params.entity, req.body || {});
  if (v.errors.length) return sendValidationErrors(res, v.errors);

  const cols = Object.keys(v.values);
  const values = cols.map((c) => v.values[c]);
  const sql = `INSERT INTO ${entity.table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`;
  const result = await pool.query(sql, values);
  await logActivity(req.user.id, 'pruebas_trazabilidad_creado', { entity: req.params.entity, id: result.rows[0].id }, req.ip);
  res.json({ id: result.rows[0].id });
}));

// PUT /trazabilidad/:entity/:id -> editar (los campos que no llegan se conservan; se valida la fila resultante)
router.put('/:entity/:id', guard(async (req, res) => {
  const entity = getEntity(req.params.entity);
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id inválido.' });

  const current = await pool.query(`SELECT * FROM ${entity.table} WHERE id = $1`, [id]);
  if (current.rows.length === 0) return res.status(404).json({ error: 'Registro no encontrado.' });

  const v = await validateRecord(ENTITIES, req.params.entity, req.body || {}, { existing: current.rows[0], id });
  if (v.errors.length) return sendValidationErrors(res, v.errors);

  const cols = Object.keys(v.values);
  if (cols.length === 0) return res.status(400).json({ error: 'Nada para actualizar.' });
  const values = cols.map((c) => v.values[c]);
  values.push(id);
  const sql = `UPDATE ${entity.table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${values.length} RETURNING id`;
  const result = await pool.query(sql, values);
  await logActivity(req.user.id, 'pruebas_trazabilidad_editado', { entity: req.params.entity, id }, req.ip);
  res.json({ id: result.rows[0].id });
}));

// DELETE /trazabilidad/:entity/:id
router.delete('/:entity/:id', guard(async (req, res) => {
  const entity = getEntity(req.params.entity);
  if (!entity) return res.status(404).json({ error: 'Entidad no encontrada.' });
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id inválido.' });

  // Borrar un centro arrastra en cascada TODOS sus datos (balance de masas, bodegas, rutas...): solo
  // se permite cuando ya no tiene recicladores ni balance de masas.
  if (req.params.entity === 'centros') {
    const dep = await pool.query(
      `SELECT (SELECT count(*) FROM tz_recicladores WHERE id_centro = $1)::int AS recicladores,
              (SELECT count(*) FROM tz_formulario_balance_masas WHERE id_centro = $1)::int AS balance`, [id]);
    const d = dep.rows[0];
    if (d.recicladores || d.balance) {
      return res.status(409).json({ error: `No se puede eliminar el centro: tiene ${d.recicladores} reciclador(es) y ${d.balance} registro(s) de balance de masas. Elimínalos primero.` });
    }
  }
  let result;
  try {
    result = await pool.query(`DELETE FROM ${entity.table} WHERE id = $1 RETURNING id`, [id]);
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'No se puede eliminar: otros registros dependen de este (por ejemplo balance de masas o rutas). Elimina primero esos registros.' });
    throw err;
  }
  if (result.rows.length === 0) return res.status(404).json({ error: 'Registro no encontrado.' });
  await logActivity(req.user.id, 'pruebas_trazabilidad_eliminado', { entity: req.params.entity, id }, req.ip);
  res.json({ message: 'Eliminado.' });
}));

module.exports = router;
