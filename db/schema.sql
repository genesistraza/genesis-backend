-- Genesis Traza - Esquema de base de datos
-- Ejecutar una sola vez contra tu base PostgreSQL (Railway/Supabase la crean por ti)

CREATE TABLE IF NOT EXISTS associations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  nit VARCHAR(30),
  recycler_count INT DEFAULT 0,
  facturacion_url TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Por si la tabla ya existia de una version anterior sin esta columna
ALTER TABLE associations ADD COLUMN IF NOT EXISTS facturacion_url TEXT;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS rut_url TEXT;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS camara_comercio_url TEXT;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS representante_cedula_url TEXT;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS routes_kml_url TEXT;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  association_id INT REFERENCES associations(id) ON DELETE SET NULL,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  phone VARCHAR(30),
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'operativo', -- 'pro' | 'admin' | 'operativo'
  is_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Constancia de aceptacion de terminos/tratamiento de datos (Ley 1581 de 2012) y verificacion en dos pasos.
ALTER TABLE users ADD COLUMN IF NOT EXISTS accepted_terms_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS verification_codes (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  code VARCHAR(6) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  category VARCHAR(20) NOT NULL, -- 'trazabilidad' | 'facturacion' | 'combo'
  name VARCHAR(100) NOT NULL,
  price_monthly INT NOT NULL,
  price_annual INT,
  description TEXT,
  features JSONB DEFAULT '[]',
  is_featured BOOLEAN DEFAULT FALSE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  association_id INT REFERENCES associations(id) ON DELETE CASCADE,
  plan_id INT REFERENCES plans(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'activa' | 'vencida' | 'cancelada'
  billing_cycle VARCHAR(10) DEFAULT 'mensual', -- 'mensual' | 'anual'
  next_due_date DATE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  subscription_id INT REFERENCES subscriptions(id) ON DELETE CASCADE,
  wompi_transaction_id VARCHAR(100),
  amount INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'aprobado' | 'rechazado'
  payment_method VARCHAR(30), -- 'NEQUI' | 'CARD' | 'PSE'
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(150) NOT NULL,
  details JSONB DEFAULT '{}',
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS association_routes (
  id SERIAL PRIMARY KEY,
  association_id INT REFERENCES associations(id) ON DELETE CASCADE,
  reciclador_name VARCHAR(150) NOT NULL,
  kml_url TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Recicladores de cada asociación (se cargan desde el Excel de recicladores del sistema
-- de trazabilidad/cumplimiento). Cada carga reemplaza por completo el listado de la asociación.
CREATE TABLE IF NOT EXISTS recicladores (
  id SERIAL PRIMARY KEY,
  association_id INT REFERENCES associations(id) ON DELETE CASCADE,
  documento_numero VARCHAR(30) NOT NULL,
  nombre_completo VARCHAR(200) NOT NULL,
  estado VARCHAR(20) DEFAULT 'Activo',
  fecha_exp_documento DATE,
  fecha_nacimiento DATE,
  direccion TEXT,
  telefono VARCHAR(30),
  tipo_vehiculo VARCHAR(50),
  placa VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS recicladores_association_idx ON recicladores (association_id);

-- Balance de masas: una fila por cada entrada de material pesada/registrada, tal como la
-- exporta el sistema de trazabilidad (formulario_de_masas). Al subir un nuevo Excel se
-- reemplazan las filas de esa asociación dentro del rango de fechas que trae el archivo,
-- para poder re-subir sin duplicar.
CREATE TABLE IF NOT EXISTS mass_balance_entries (
  id SERIAL PRIMARY KEY,
  association_id INT REFERENCES associations(id) ON DELETE CASCADE,
  fecha DATE NOT NULL,
  semana INT,
  reciclador_documento VARCHAR(30),
  reciclador_nombre VARCHAR(200),
  material_codigo VARCHAR(10),
  material_desc VARCHAR(100),
  toneladas NUMERIC(12,4) DEFAULT 0,
  toneladas_rechazo NUMERIC(12,4) DEFAULT 0,
  valor_kilogramo NUMERIC(12,2),
  valor_total NUMERIC(14,2),
  tipo_destino VARCHAR(10),
  sitio_destino VARCHAR(50),
  placa VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mass_balance_association_fecha_idx ON mass_balance_entries (association_id, fecha);

-- Fila unica con el correo y telefono a donde llegan las notificaciones de pago
-- (hoy por correo, mas adelante tambien por WhatsApp). Se edita desde el panel, en vez
-- de quedar fijo en el codigo.
CREATE TABLE IF NOT EXISTS notification_settings (
  id INT PRIMARY KEY DEFAULT 1,
  email VARCHAR(150),
  phone VARCHAR(30),
  updated_at TIMESTAMP DEFAULT NOW(),
  CHECK (id = 1)
);
INSERT INTO notification_settings (id, email, phone) VALUES (1, 'genesistraza@gmail.com', '3228753230')
ON CONFLICT (id) DO NOTHING;

-- Fila unica que permite cerrar la sesion en todos los dispositivos de una sola vez: cualquier
-- token (JWT) emitido ANTES de sessions_invalidated_at deja de servir, sin importar que su firma
-- sea valida y no haya expirado - los tokens son sin estado, asi que esta es la unica forma de
-- "recordarlos" e invalidarlos en bloque. TIMESTAMPTZ (no TIMESTAMP) a proposito: se compara
-- directo contra el "iat" del JWT como instante absoluto, y un TIMESTAMP sin zona horaria
-- se guarda/lee corrido segun el timezone de la sesion de Postgres (el mismo tipo de bug de
-- zona horaria que ya se corrigio para las fechas del balance de masas).
CREATE TABLE IF NOT EXISTS security_settings (
  id INT PRIMARY KEY DEFAULT 1,
  sessions_invalidated_at TIMESTAMPTZ,
  CHECK (id = 1)
);
INSERT INTO security_settings (id, sessions_invalidated_at) VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;
ALTER TABLE security_settings ALTER COLUMN sessions_invalidated_at TYPE TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS news_articles (
  id SERIAL PRIMARY KEY,
  title VARCHAR(300) NOT NULL,
  summary TEXT,
  link TEXT NOT NULL UNIQUE,
  image_url TEXT,
  source VARCHAR(150),
  published_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS error_logs (
  id SERIAL PRIMARY KEY,
  level VARCHAR(20) DEFAULT 'error',
  message TEXT NOT NULL,
  stack TEXT,
  route VARCHAR(150),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Una asociación solo puede tener una suscripción activa a la vez. Al activar
-- una nueva (pago aprobado o corrección manual del admin) la anterior se pasa
-- a 'cancelada' antes de insertar/activar esta, así este índice nunca choca.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_association_idx ON subscriptions (association_id) WHERE status = 'activa';

-- Evita duplicar los planes semilla si la migración se corre más de una vez.
-- Es parcial (solo entre planes activos) porque ya existen filas duplicadas
-- desactivadas de una migración anterior que no tenía esta restricción.
CREATE UNIQUE INDEX IF NOT EXISTS plans_category_name_active_idx ON plans (category, name) WHERE active;

-- Semilla inicial de planes (coinciden con la landing)
INSERT INTO plans (category, name, price_monthly, price_annual, description, features, is_featured) VALUES
('trazabilidad','Hasta 20 recicladores',150000,125000,'Para asociaciones pequeñas que necesitan estar al día con el SUI.','["Cargue al SUI","Balance de masas y caracterización","1 usuario administrador","Soporte por correo"]',false),
('trazabilidad','21 a 60 recicladores',280000,235000,'Cumplimiento normativo integral para asociaciones en crecimiento.','["SUI, Contraloría y Superservicios","Balance de masas, caracterización y vehículos","Hasta 5 usuarios","Acompañamiento mensual"]',true),
('trazabilidad','Más de 60 recicladores',400000,335000,'Para asociaciones grandes con operación de alto volumen.','["Todo lo de 21 a 60 recicladores","Usuarios ilimitados","Asesor dedicado"]',false),
('facturacion','Básico',25000,21000,'Para empezar a facturar electrónicamente ante la DIAN.','["80 documentos electrónicos/mes","1 usuario","Soporte por correo"]',false),
('facturacion','Profesional',45000,38000,'Más documentos que planes equivalentes del mercado.','["300 documentos electrónicos/mes","Hasta 3 usuarios","Soporte por WhatsApp"]',true),
('facturacion','Documentación ilimitada',89000,75000,'Factura sin preocuparte por límites de documentos.','["Documentos electrónicos ilimitados","Usuarios ilimitados","Soporte prioritario"]',false),
('combo','Combo Inicial',160000,135000,'Trazabilidad hasta 20 recicladores + facturación Básico.','["Todo Trazabilidad Hasta 20","80 documentos/mes"]',false),
('combo','Combo Crecimiento',295000,248000,'Trazabilidad 21-60 recicladores + facturación Profesional.','["Todo Trazabilidad 21-60","300 documentos/mes"]',true),
('combo','Combo Total',440000,370000,'Trazabilidad +60 recicladores + facturación ilimitada.','["Todo Trazabilidad +60","Documentos ilimitados"]',false)
ON CONFLICT (category, name) WHERE active DO NOTHING;

-- =====================================================================================
-- Modulo "Pruebas" (trazabilidad nativa, tablas tz_*) - replica el mecanismo de registro
-- del sistema aparte en genesis-traza.com (ASP.NET + MySQL), pero con diseño propio y
-- normalizado. Aislado por completo de associations/recicladores/mass_balance_entries
-- (las tablas reales en produccion) - vive solo bajo /admin -> Pruebas mientras se decide
-- si se integra de verdad. No trae datos historicos, solo la estructura.
-- =====================================================================================

-- Catalogo generico: reemplaza ~15 tablas casi identicas de codigo/descripcion del sistema
-- original (estados, tipos_documento, usuario_uso, usuario_tipo, etc.) por una sola tabla
-- con "categoria" como discriminador. Misma finalidad (listas de referencia), diseño mas simple.
CREATE TABLE IF NOT EXISTS tz_catalogos (
  id SERIAL PRIMARY KEY,
  categoria VARCHAR(60) NOT NULL,
  codigo VARCHAR(30) NOT NULL,
  descripcion VARCHAR(255) NOT NULL,
  grupo VARCHAR(120),
  orden INT DEFAULT 0,
  UNIQUE (categoria, codigo)
);

CREATE TABLE IF NOT EXISTS tz_centros (
  id SERIAL PRIMARY KEY,
  cod_centro VARCHAR(30) UNIQUE,
  desc_centro VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tz_bodegas (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  cod_bodega VARCHAR(30),
  desc_bodega VARCHAR(255),
  desc_ubicacion VARCHAR(255),
  direccion VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS tz_localidades (
  id SERIAL PRIMARY KEY,
  cod_localidad VARCHAR(30),
  desc_localidad VARCHAR(255) NOT NULL,
  ciudad VARCHAR(120)
);

CREATE TABLE IF NOT EXISTS tz_numacros (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  id_localidad INT REFERENCES tz_localidades(id),
  cod_numacro VARCHAR(30)
);

CREATE TABLE IF NOT EXISTS tz_tipos_material (
  id SERIAL PRIMARY KEY,
  cod_tipo_material VARCHAR(30) UNIQUE,
  desc_familia VARCHAR(255),
  desc_tipo_material VARCHAR(255) NOT NULL,
  cod_tipo_material_padre VARCHAR(30),
  desc_tipo_material_padre VARCHAR(255),
  desc_familia_padre VARCHAR(255),
  secuencia_orden INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tz_recicladores (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  nombre_completo VARCHAR(255) NOT NULL,
  nro_documento VARCHAR(30) NOT NULL,
  estado VARCHAR(20) DEFAULT 'Activo',
  fecha_exp_documento DATE,
  fecha_nacimiento DATE,
  direccion VARCHAR(255),
  telefono VARCHAR(30),
  tipo_de_vehiculo VARCHAR(60),
  placa VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);

-- El formulario mas usado del sistema original (144,882 registros historicos alla) -
-- captura diaria de material recuperado por reciclador.
CREATE TABLE IF NOT EXISTS tz_formulario_balance_masas (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  id_reciclador INT REFERENCES tz_recicladores(id),
  id_tipo_material INT REFERENCES tz_tipos_material(id),
  id_numacro INT REFERENCES tz_numacros(id),
  id_bodega INT REFERENCES tz_bodegas(id),
  fecha DATE NOT NULL,
  cantidad NUMERIC(12,4) DEFAULT 0,
  valor NUMERIC(12,2) DEFAULT 0,
  cantidad_rechazo NUMERIC(12,4) DEFAULT 0,
  cantidad_nosui NUMERIC(12,4) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tz_formulario_microrrutas (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  id_reciclador INT REFERENCES tz_recicladores(id),
  fecha_entrada_operacion DATE,
  estado VARCHAR(20) DEFAULT 'Activo',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tz_formulario_microrrutas_detalle (
  id SERIAL PRIMARY KEY,
  id_formulario_microrruta INT REFERENCES tz_formulario_microrrutas(id) ON DELETE CASCADE,
  desc_microrruta VARCHAR(255),
  id_tipo_microrruta INT REFERENCES tz_catalogos(id),
  direccion_inicio VARCHAR(255),
  hora_inicio VARCHAR(20),
  direccion_finalizacion VARCHAR(255),
  hora_finalizacion VARCHAR(20),
  distancia_via_pavimentada NUMERIC(10,2),
  distancia_via_no_pavimentada NUMERIC(10,2),
  frecuencia_semanal INT,
  dias_frecuencia VARCHAR(60),
  id_estacion_transferencia INT REFERENCES tz_catalogos(id),
  tipo_barrido VARCHAR(120)
);

-- Usuarios DEL SERVICIO (predios/suscriptores, para el reporte al SUI) - no confundir con
-- los usuarios del sistema Genesis Traza. Concepto nuevo, no existe hoy en produccion.
CREATE TABLE IF NOT EXISTS tz_usuarios (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  id_numacro INT REFERENCES tz_numacros(id),
  nuis_nuid VARCHAR(60),
  direccion_usuario VARCHAR(255),
  id_usuario_uso INT REFERENCES tz_catalogos(id),
  id_usuario_tipo INT REFERENCES tz_catalogos(id),
  id_usuario_multiusuario INT REFERENCES tz_catalogos(id),
  id_usuario_ubicacion INT REFERENCES tz_catalogos(id),
  id_usuario_clase_de_uso INT REFERENCES tz_catalogos(id),
  id_usuario_tipo_de_aforo INT REFERENCES tz_catalogos(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tz_formulario_aprovechamiento (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  id_usuario INT REFERENCES tz_usuarios(id),
  id_numacro INT REFERENCES tz_numacros(id),
  periodo VARCHAR(20),
  toneladas NUMERIC(12,4) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tz_formulario_recursos (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  fecha DATE,
  nuap VARCHAR(60),
  operador VARCHAR(120),
  valor NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Reporte de ventas de material aprovechado (formato tipo SUI: comprador, factura, IVA).
CREATE TABLE IF NOT EXISTS tz_formulario_ventas (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  anio INT,
  periodo VARCHAR(20),
  fecha_habilitacion DATE,
  fecha_certificacion DATE,
  tipo_identificacion VARCHAR(30),
  nro_identificacion VARCHAR(30),
  nro_factura VARCHAR(60),
  nombre_comprador VARCHAR(255),
  material VARCHAR(120),
  kg NUMERIC(12,2) DEFAULT 0,
  toneladas NUMERIC(12,4) DEFAULT 0,
  valor_kilo NUMERIC(12,2) DEFAULT 0,
  valor_sin_iva NUMERIC(14,2) DEFAULT 0,
  iva NUMERIC(14,2) DEFAULT 0,
  valor_con_iva NUMERIC(14,2) DEFAULT 0,
  depto_origen VARCHAR(120),
  municipio_origen VARCHAR(120),
  origen_residuos VARCHAR(120),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tz_formulario_pago_seguridad (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  id_reciclador INT REFERENCES tz_recicladores(id),
  id_tipo_concepto INT REFERENCES tz_catalogos(id),
  fecha DATE,
  planilla VARCHAR(60),
  cantidad NUMERIC(12,2) DEFAULT 0,
  valor NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tz_formulario_pago_tarifa (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  id_reciclador INT REFERENCES tz_recicladores(id),
  id_tipo_concepto INT REFERENCES tz_catalogos(id),
  fecha DATE,
  nro_referencia VARCHAR(60),
  cantidad NUMERIC(12,2) DEFAULT 0,
  valor NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================================================
-- Modulos agregados tras el analisis del Decreto 596/2016, Decreto 271/2026 y las
-- Resoluciones CRA 1027/1037/2026: cosas que la ley exige y el sistema original (y el
-- nuestro) no cubrian todavia. Siguen siendo parte del sandbox "Pruebas" (tz_*).
-- =====================================================================================

-- RUP (Registro Unico de Prestadores) - inscripcion formal ante la SSPD, requisito de la
-- Fase 1 de formalizacion del Decreto 596/2016. Es un dato del centro, no se repite.
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS rup_numero VARCHAR(60);
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS rup_fecha_inscripcion DATE;
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS eca_numero VARCHAR(60);

-- Las 8 fases de formalizacion progresiva del Art. 2.3.2.5.3.2 (Decreto 596/2016): una
-- fila por fase por centro, para llevar el checklist de cumplimiento en vez de tenerlo
-- solo en la cabeza de alguien.
CREATE TABLE IF NOT EXISTS tz_formalizacion_fases (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  fase INT NOT NULL,
  descripcion_fase VARCHAR(255),
  estado VARCHAR(30) DEFAULT 'Pendiente',
  fecha_completada DATE,
  observaciones TEXT,
  UNIQUE (id_centro, fase)
);

-- Macrorrutas: agrupan formularios de balance de masas para poder calcular el % de
-- aceptacion exigido por el DINC (Art. 2.3.2.5.2.2.4 - minimo 80% para no tener descuento).
CREATE TABLE IF NOT EXISTS tz_macrorrutas (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  cod_macrorruta VARCHAR(30),
  desc_macrorruta VARCHAR(255)
);
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS id_macrorruta INT REFERENCES tz_macrorrutas(id);

-- PQR (peticiones, quejas y reclamos) - obligatorio desde la Fase 7 de formalizacion.
CREATE TABLE IF NOT EXISTS tz_pqr (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  tipo VARCHAR(30) DEFAULT 'Peticion',
  fecha DATE,
  nombre_solicitante VARCHAR(255),
  documento_solicitante VARCHAR(30),
  descripcion TEXT,
  estado VARCHAR(30) DEFAULT 'Abierta',
  fecha_respuesta DATE,
  respuesta TEXT
);

-- Seguridad social del reciclador (Decreto 271/2026, vigente desde el 1 de julio de 2026):
-- afiliacion a salud, ARL y BEPS financiadas desde la remuneracion tarifaria, sin que exista
-- relacion laboral con la organizacion.
CREATE TABLE IF NOT EXISTS tz_seguridad_social (
  id SERIAL PRIMARY KEY,
  id_reciclador INT REFERENCES tz_recicladores(id) ON DELETE CASCADE,
  eps VARCHAR(120),
  estado_afiliacion_eps VARCHAR(30) DEFAULT 'Sin afiliar',
  arl VARCHAR(120),
  estado_afiliacion_arl VARCHAR(30) DEFAULT 'Sin afiliar',
  base_cotizacion_arl NUMERIC(12,2),
  beps_afiliado BOOLEAN DEFAULT false,
  aporte_beps_mensual NUMERIC(12,2),
  fecha_actualizacion DATE,
  UNIQUE (id_reciclador)
);

-- Logo de cada asociacion: se sube una sola vez desde el panel de administrador y se usa en el
-- dashboard del cliente, las facturas impresas, las planillas y el sandbox Pruebas.
ALTER TABLE associations ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- Datos FIJOS de la asociacion para el reporte al SUI (los configura el administrador una vez,
-- no se digitan en la captura diaria): tipo y numero unico del sitio de destino del rechazo.
-- El formulario original nunca los pedia por renglon, salian siempre iguales en el export.
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS id_tipo_destino INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS numero_sitio_destino VARCHAR(60);

-- El formulario de Balance de Masas del sistema original tiene dos selectores "Microruta 1" y
-- "Microruta 2" por reciclador/dia; se guardan aqui (apuntan al detalle de la microrruta).
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS id_microrruta_1 INT REFERENCES tz_formulario_microrrutas_detalle(id) ON DELETE SET NULL;
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS id_microrruta_2 INT REFERENCES tz_formulario_microrrutas_detalle(id) ON DELETE SET NULL;

-- Datos de encabezado del centro/asociacion, para membretar documentos imprimibles
-- (planillas de recepcion, facturas) igual a como los usa la asociacion en la vida real.
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS nit VARCHAR(30);
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS direccion VARCHAR(255);
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS telefono VARCHAR(60);
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS correo VARCHAR(120);

-- Correccion de formato: el cargue real de "Balance de Masas" que recibe el validador del SUI
-- (Anexo A del Instructivo de cargue de aprovechamiento) tiene exactamente 11 columnas con
-- codigos numericos fijos (no texto libre): NUECA, NUMACRO, numero de semana del MES (1-5, no
-- semana del año), tipo/numero de identificacion del reciclador, placa, cantidad entrante,
-- tipo de material (codigo DTGA vigente, no la descripcion), rechazo, tipo de sitio de destino
-- (1=Relleno sanitario, 2=Estacion de transferencia) y el numero unico de ese sitio de destino.
-- Los catalogos 'tipos_identificacion' y 'destinos_rechazo' ya existian con los codigos
-- correctos (1/2/3/4 y 1/2) pero no estaban conectados a ninguna tabla; se conectan aqui.
ALTER TABLE tz_recicladores ADD COLUMN IF NOT EXISTS id_tipo_identificacion INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS id_tipo_destino INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS numero_sitio_destino VARCHAR(60);

-- Semilla de catalogos para los modulos nuevos
INSERT INTO tz_catalogos (categoria, codigo, descripcion, grupo, orden) VALUES
('formalizacion_estado','pendiente','Pendiente',NULL,1),
('formalizacion_estado','en_proceso','En proceso',NULL,2),
('formalizacion_estado','completada','Completada',NULL,3),
('pqr_tipo','peticion','Petición',NULL,1),
('pqr_tipo','queja','Queja',NULL,2),
('pqr_tipo','reclamo','Reclamo',NULL,3),
('pqr_estado','abierta','Abierta',NULL,1),
('pqr_estado','en_proceso','En proceso',NULL,2),
('pqr_estado','cerrada','Cerrada',NULL,3),
('afiliacion_estado','sin_afiliar','Sin afiliar',NULL,1),
('afiliacion_estado','en_tramite','En trámite',NULL,2),
('afiliacion_estado','afiliado','Afiliado',NULL,3)
ON CONFLICT (categoria, codigo) DO NOTHING;

-- Semilla de las 8 fases del Art. 2.3.2.5.3.2 (solo la descripcion; el estado por cada
-- centro se crea cuando el admin registra el centro en el nuevo modulo).
INSERT INTO tz_catalogos (categoria, codigo, descripcion, grupo, orden) VALUES
('fase_formalizacion','1','Fase 1 — Inscripción en el RUP',NULL,1),
('fase_formalizacion','2','Fase 2 — Área de servicio, toneladas, ECA y vehículos',NULL,2),
('fase_formalizacion','3','Fase 3 — Adopción del CCU',NULL,3),
('fase_formalizacion','4','Fase 4 — Portafolio, plan de negocio, base de usuarios y web',NULL,4),
('fase_formalizacion','5','Fase 5 — Calibración de básculas y supervisores',NULL,5),
('fase_formalizacion','6','Fase 6 — Planta de personal y microrrutas',NULL,6),
('fase_formalizacion','7','Fase 7 — Registro de PQR y planes de emergencia',NULL,7),
('fase_formalizacion','8','Fase 8 — Estados financieros y área georreferenciada',NULL,8)
ON CONFLICT (categoria, codigo) DO NOTHING;

-- Semilla de catalogos (valores reales tomados del sistema original)
INSERT INTO tz_catalogos (categoria, codigo, descripcion, grupo, orden) VALUES
('estados','ac','Activo',NULL,1),
('estados','des','Desactivado',NULL,2),
('tipos_documento','NIT','NIT',NULL,1),
('tipos_documento','CC','CC',NULL,2),
('tipos_documento','PAS','Pasaporte',NULL,3),
('tipos_identificacion','1','Cédula de Ciudadanía (CC)',NULL,1),
('tipos_identificacion','2','Cédula de Extranjería (CE)',NULL,2),
('tipos_identificacion','3','Pasaporte',NULL,3),
('tipos_identificacion','4','NIT',NULL,4),
('tipos_microrruta','1','Recolección de residuos no aprovechables',NULL,1),
('tipos_microrruta','2','Barrido y limpieza de vías y áreas públicas',NULL,2),
('tipos_microrruta','3','Limpieza de playas',NULL,3),
('tipos_microrruta','4','Corte de césped',NULL,4),
('tipos_microrruta','5','Poda de árboles',NULL,5),
('tipos_microrruta','6','Recolección de residuos aprovechables',NULL,6),
('tipos_microrruta','7','Recolección de residuos de barrido y limpieza de vías y áreas públicas',NULL,7),
('tipos_microrruta','8','Recolección de residuos de corte de césped y poda de árboles',NULL,8),
('destinos_rechazo','1','Relleno Sanitario',NULL,1),
('destinos_rechazo','2','Estación de Transferencia',NULL,2),
('estaciones_transferencia','1','SI',NULL,1),
('estaciones_transferencia','2','NO',NULL,2),
('operadores','39834','Promo ambiental',NULL,1),
('operadores','3339','Lime',NULL,2),
('operadores','39837','Bogotá Limpia',NULL,3),
('operadores','2614','Ciudad Limpia',NULL,4),
('operadores','40018','Area limpia',NULL,5),
('usuario_aforado','0','No es un usuario aforado',NULL,1),
('usuario_aforado','1','Es un usuario aforado',NULL,2),
('usuario_clase_de_uso','0','No aplica',NULL,1),
('usuario_clase_de_uso','1','Bajo-Bajo',NULL,2),
('usuario_clase_de_uso','2','Bajo',NULL,3),
('usuario_clase_de_uso','3','Medio-Bajo',NULL,4),
('usuario_clase_de_uso','4','Medio',NULL,5),
('usuario_clase_de_uso','5','Medio-Alto',NULL,6),
('usuario_clase_de_uso','6','Alto',NULL,7),
('usuario_clase_de_uso','10','Industrial',NULL,8),
('usuario_clase_de_uso','11','Comercial',NULL,9),
('usuario_clase_de_uso','12','Oficial',NULL,10),
('usuario_multiusuario','1','Es un usuario Multiusuario',NULL,1),
('usuario_multiusuario','2','No es un usuario Multiusuario',NULL,2),
('usuario_tipo','0','No aplica',NULL,1),
('usuario_tipo','1','Gran generador',NULL,2),
('usuario_tipo','2','Pequeño generador',NULL,3),
('usuario_tipo_de_aforo','0','No aplica',NULL,1),
('usuario_tipo_de_aforo','2','Aforo ordinario',NULL,2),
('usuario_tipo_de_aforo','3','Aforo extraordinario',NULL,3),
('usuario_tipo_de_aforo','4','Aforo permanente',NULL,4),
('usuario_ubicacion','0','No aplica',NULL,1),
('usuario_ubicacion','1','Rural',NULL,2),
('usuario_ubicacion','2','Urbano',NULL,3),
('usuario_ubicacion','3','Expansión Urbana',NULL,4),
('usuario_uso','1','Residencial',NULL,1),
('usuario_uso','2','Comercial',NULL,2),
('usuario_uso','3','Industrial',NULL,3),
('usuario_uso','4','Oficial',NULL,4),
('tipos_concepto_pago_seguridad','1','Pago salud','Pagos',1),
('tipos_concepto_pago_seguridad','2','Pago pensión','Pagos',2),
('tipos_concepto_pago_tarifa','001','Pago tarifa','Pagos',1)
ON CONFLICT (categoria, codigo) DO NOTHING;

-- Semilla de tipos de material: los 41 materiales reales del sistema original (asociacion
-- ASORETRIP), agrupados en sus mismas 7 familias (Metales, Papel y Carton, Plasticos, PET,
-- Vidrio, Textil, Madera) - confirmado viendo la grilla real de Balance de Masas en vivo.
INSERT INTO tz_tipos_material (cod_tipo_material, desc_familia, desc_tipo_material, secuencia_orden) VALUES
('101','Metales','Aluminio',1),
('102','Metales','Chatarra',2),
('103','Metales','Cobre',3),
('104','Metales','Bronce',4),
('105','Metales','Antimonio',5),
('106','Metales','Acero',6),
('199','Metales','Otros metales',7),
('201','Papel y Carton','Archivo',8),
('202','Papel y Carton','Carton',9),
('203','Papel y Carton','Cubetas o Paneles',10),
('204','Papel y Carton','Periodico',11),
('205','Papel y Carton','Plegadiza',12),
('206','Papel y Carton','Tetra Pack',13),
('207','Papel y Carton','Plastificado',14),
('208','Papel y Carton','Kraf',15),
('299','Papel y Carton','Otros Papel y Carton',16),
('301','Plasticos','Acrilico',17),
('302','Plasticos','Pasta',18),
('303','PET','Pet',19),
('304','Plasticos','PVC',20),
('305','Plasticos','Plastico Blanco',21),
('306','Plasticos','Polietileno',22),
('307','Plasticos','Soplado',23),
('308','Plasticos','Polipropileno',24),
('399','Plasticos','Otros Plasticos',25),
('499','Vidrio','Otros Vidrios',26),
('599','Textil','Otros Textiles',27),
('699','Madera','Otros Maderables',28),
('3031','PET','Pet Ambar',29),
('3032','PET','Pet Verde',30),
('3033','PET','Pet Aceite',31),
('3034','PET','Pet Cristal',32),
('3035','PET','Pet Etiqueta',33),
('3036','PET','Pet Revuelto',34),
('3037','PET','Pet Cristal Suelto',35),
('3038','PET','Pet Cristal Embalado',36),
('3039','PET','Pet Cristal por BF',37),
('3041','Plasticos','PVC BLANDO',38),
('3042','Plasticos','PVC Rígido',39),
('3991','Plasticos','Plastico Manguera',40),
('3992','Plasticos','Plastico Negro',41)
ON CONFLICT (cod_tipo_material) DO NOTHING;

-- =====================================================================================
-- Segunda pasada de correccion contra el Anexo A (instructivo de cargue de aprovechamiento
-- al SUI): campos que la organizacion de recicladores (prestador) SI debe reportar y que
-- este sandbox no tenia todavia, ademas de la misma correccion de "NUMACRO = macrorruta"
-- que ya se hizo en Balance de Masas.
-- =====================================================================================

-- Area de Prestacion del Servicio (NUAP): un prestador puede operar varias; cada ECA y
-- cada macrorruta pertenecen a una NUAP especifica, no directamente al centro/prestador.
CREATE TABLE IF NOT EXISTS tz_areas_prestacion (
  id SERIAL PRIMARY KEY,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  cod_departamento_dane VARCHAR(2),
  cod_municipio_dane VARCHAR(3),
  nombre_area VARCHAR(255) NOT NULL,
  fecha_entrada_operacion DATE,
  id_estado INT REFERENCES tz_catalogos(id),
  fecha_estado DATE
);

-- La ECA (aqui modelada como tz_bodegas) necesita mucho mas que un nombre: predio,
-- coordenadas MAGNA-SIRGAS, propietario, contrato y capacidades, tal como lo pide el
-- formulario "Registro de estaciones de clasificacion y aprovechamiento".
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS id_area_prestacion INT REFERENCES tz_areas_prestacion(id);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS fecha_inicio_operaciones DATE;
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS informacion_complementaria VARCHAR(255);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS longitud NUMERIC(10,6);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS latitud NUMERIC(10,6);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS id_propietario_predio INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS id_tipo_contrato INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS capacidad_operacion_ton_mes NUMERIC(12,2);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS capacidad_almacenamiento_m3 NUMERIC(12,2);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS capacidad_almacenamiento_ton NUMERIC(12,2);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS id_uso_suelo_compatible INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS id_uso_suelo INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS id_estado INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_bodegas ADD COLUMN IF NOT EXISTS fecha_estado DATE;

-- Macrorrutas: pertenecen a una NUAP, y tienen su propio ciclo de fecha/estado.
ALTER TABLE tz_macrorrutas ADD COLUMN IF NOT EXISTS id_area_prestacion INT REFERENCES tz_areas_prestacion(id);
ALTER TABLE tz_macrorrutas ADD COLUMN IF NOT EXISTS fecha_inicio_operacion DATE;
ALTER TABLE tz_macrorrutas ADD COLUMN IF NOT EXISTS id_estado INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_macrorrutas ADD COLUMN IF NOT EXISTS fecha_estado DATE;

-- "Relacion de miembros de la organizacion": el SUI pide el departamento/municipio DANE
-- donde el reciclador presta el servicio, para verificar el 80% de recicladores de oficio.
ALTER TABLE tz_recicladores ADD COLUMN IF NOT EXISTS cod_departamento_dane VARCHAR(2);
ALTER TABLE tz_recicladores ADD COLUMN IF NOT EXISTS cod_municipio_dane VARCHAR(3);

-- "Base de datos de usuarios": el campo NUMACRO es el codigo de la MACRORRUTA (igual que en
-- Balance de Masas), no tiene relacion con tz_numacros (zonas internas de este sandbox).
ALTER TABLE tz_usuarios ADD COLUMN IF NOT EXISTS id_macrorruta INT REFERENCES tz_macrorrutas(id);

-- "Suscriptores beneficiarios del incentivo DINC": el valor del incentivo a otorgar por
-- suscriptor y periodo, ademas de las toneladas ya capturadas.
ALTER TABLE tz_formulario_aprovechamiento ADD COLUMN IF NOT EXISTS dinc_incentivo NUMERIC(14,2);

-- "Recepcion de recursos de aprovechamiento": el periodo que se esta pagando y la fecha en
-- que se recibio el giro son dos datos distintos; antes solo habia un campo "fecha".
ALTER TABLE tz_formulario_recursos ADD COLUMN IF NOT EXISTS periodo_pago VARCHAR(20);

-- "Toneladas aprovechadas" (ventas): le faltaban los campos que exige la factura electronica
-- DIAN y la trazabilidad del origen del residuo que pide el SUI.
ALTER TABLE tz_formulario_ventas ADD COLUMN IF NOT EXISTS id_bodega INT REFERENCES tz_bodegas(id);
ALTER TABLE tz_formulario_ventas ADD COLUMN IF NOT EXISTS fecha_factura DATE;
ALTER TABLE tz_formulario_ventas ADD COLUMN IF NOT EXISTS digito_verificacion VARCHAR(5);
ALTER TABLE tz_formulario_ventas ADD COLUMN IF NOT EXISTS id_entregado_otra_eca INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_formulario_ventas ADD COLUMN IF NOT EXISTS codigo_cufe VARCHAR(120);
ALTER TABLE tz_formulario_ventas ADD COLUMN IF NOT EXISTS id_origen_residuos_usuario INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_formulario_ventas ADD COLUMN IF NOT EXISTS id_origen_residuos_area INT REFERENCES tz_catalogos(id);
ALTER TABLE tz_formulario_ventas ADD COLUMN IF NOT EXISTS id_aplica_decreto_596 INT REFERENCES tz_catalogos(id);

INSERT INTO tz_catalogos (categoria, codigo, descripcion, grupo, orden) VALUES
('si_no','1','Sí',NULL,1),
('si_no','2','No',NULL,2),
('estado_operacion','1','En operación',NULL,1),
('estado_operacion','2','Inactiva',NULL,2),
('propietario_predio','1','Prestador',NULL,1),
('propietario_predio','2','Municipio',NULL,2),
('propietario_predio','3','Departamento',NULL,3),
('propietario_predio','4','Otra persona natural o jurídica',NULL,4),
('tipo_contrato_predio','1','Arrendamiento escrito',NULL,1),
('tipo_contrato_predio','2','Convenio de arrendamiento verbal',NULL,2),
('tipo_contrato_predio','3','Comodato',NULL,3),
('tipo_contrato_predio','4','Propia',NULL,4),
('tipo_contrato_predio','5','Otro',NULL,5),
('uso_suelo_predio','1','Residencial',NULL,1),
('uso_suelo_predio','2','Comercial',NULL,2),
('uso_suelo_predio','3','Mixto',NULL,3),
('uso_suelo_predio','4','Industrial',NULL,4),
('origen_residuos_usuario','1','Suscriptores no aforados',NULL,1),
('origen_residuos_usuario','2','Suscriptores aforados',NULL,2),
('origen_residuos_usuario','3','Otro',NULL,3),
('origen_residuos_area','1','Rural',NULL,1),
('origen_residuos_area','2','Urbana',NULL,2)
ON CONFLICT (categoria, codigo) DO NOTHING;

-- Auditoria: integridad a nivel de base de datos.
-- Referencia de Wompi de cada intento de pago (el webhook ubica el pago por ella, no por el monto).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference VARCHAR(80);
CREATE UNIQUE INDEX IF NOT EXISTS payments_reference_idx ON payments (reference) WHERE reference IS NOT NULL;

-- Balance de masas: nada negativo, y el rechazo / no SUI nunca superan la cantidad del material.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tz_balance_masas_cantidades_chk') THEN
    ALTER TABLE tz_formulario_balance_masas ADD CONSTRAINT tz_balance_masas_cantidades_chk CHECK (
      cantidad >= 0 AND valor >= 0 AND cantidad_rechazo >= 0 AND cantidad_nosui >= 0
      AND cantidad_rechazo <= cantidad AND cantidad_nosui <= cantidad
    );
  END IF;
END $$;

-- Ventas: el tipo de identificacion del comprador estaba como texto libre ('NIT') pero el motor lo
-- trata como una opcion del catalogo (por id), y el listado fallaba con "integer = character
-- varying". Ahora es una referencia real al catalogo; los valores viejos se convierten.
ALTER TABLE tz_formulario_ventas ADD COLUMN IF NOT EXISTS id_tipo_identificacion INT REFERENCES tz_catalogos(id);
UPDATE tz_formulario_ventas v SET id_tipo_identificacion = c.id
FROM tz_catalogos c
WHERE v.id_tipo_identificacion IS NULL AND c.categoria = 'tipos_identificacion'
  AND ((upper(trim(v.tipo_identificacion)) = 'NIT' AND c.codigo = '4')
    OR (upper(trim(v.tipo_identificacion)) IN ('CC', 'CEDULA', 'CÉDULA') AND c.codigo = '1')
    OR (upper(trim(v.tipo_identificacion)) IN ('CE') AND c.codigo = '2')
    OR (upper(trim(v.tipo_identificacion)) IN ('PASAPORTE', 'PP') AND c.codigo = '3'));

-- Un reciclador (documento) no puede repetirse dentro del mismo centro.
CREATE UNIQUE INDEX IF NOT EXISTS tz_recicladores_documento_centro_idx ON tz_recicladores (id_centro, nro_documento);

-- Comprobantes de Balance de Masas: cada vez que se imprime, se guarda una "foto" (snapshot)
-- INMUTABLE de lo que había en ese momento -- nunca se edita ni se borra por la aplicación --
-- con un token imposible de adivinar (32 bytes al azar) para el QR que lleva a la version
-- publica y verificable de ese comprobante. Asi, si alguien altera a mano el papel impreso,
-- cualquiera que escanee el QR ve los datos reales guardados en el servidor, no el papel alterado.
CREATE TABLE IF NOT EXISTS tz_comprobantes (
  id SERIAL PRIMARY KEY,
  token VARCHAR(64) UNIQUE NOT NULL,
  numero VARCHAR(60) NOT NULL,
  id_centro INT REFERENCES tz_centros(id),
  id_reciclador INT REFERENCES tz_recicladores(id),
  fecha DATE NOT NULL,
  formato VARCHAR(20) NOT NULL DEFAULT 'carta',
  snapshot JSONB NOT NULL,
  codigo_verificacion VARCHAR(20) NOT NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tz_comprobantes_reciclador_fecha_idx ON tz_comprobantes (id_reciclador, fecha);

-- ============================================================================================
-- Cadena de integridad (huellas + sello diario con OpenTimestamps)
-- Cada registro sellado guarda la huella (sha256) de su contenido canonico, encadenada a la del
-- registro anterior de su mismo centro. Cada noche las huellas del dia se combinan en un arbol
-- Merkle y la raiz se ancla en Bitcoin con OpenTimestamps (jobs/sellosDiarios.js, utils/huella.js).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS tz_huellas (
  id BIGSERIAL PRIMARY KEY,
  id_centro INT,
  tipo VARCHAR(30) NOT NULL,
  ref_id BIGINT NOT NULL,
  version VARCHAR(30) NOT NULL,
  huella_dato CHAR(64) NOT NULL,
  huella_prev CHAR(64) NOT NULL,
  huella CHAR(64) NOT NULL UNIQUE,
  fecha_sello DATE NOT NULL,
  prueba JSONB,
  creado TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tipo, ref_id)
);
CREATE INDEX IF NOT EXISTS tz_huellas_centro_idx ON tz_huellas (id_centro, id);
CREATE INDEX IF NOT EXISTS tz_huellas_fecha_idx ON tz_huellas (fecha_sello);

CREATE TABLE IF NOT EXISTS tz_sellos_diarios (
  fecha DATE PRIMARY KEY,
  raiz CHAR(64) NOT NULL,
  total INT NOT NULL,
  archivo TEXT NOT NULL,
  ots BYTEA,
  estado VARCHAR(20) NOT NULL DEFAULT 'calculado',
  bloque INT,
  error TEXT,
  creado TIMESTAMPTZ DEFAULT NOW(),
  actualizado TIMESTAMPTZ DEFAULT NOW()
);

-- Candados en la base de datos (no solo en la aplicacion): un comprobante nunca se modifica ni se
-- borra, y una huella solo admite que se le agregue su prueba Merkle una vez.
CREATE OR REPLACE FUNCTION tz_bloquear_comprobantes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Los comprobantes son inmutables: no se pueden modificar ni borrar.';
END $$ LANGUAGE plpgsql;
-- created_by sin llave foranea: con ON DELETE SET NULL, borrar un usuario intentaba modificar
-- comprobantes inmutables y fallaba. Queda el id como dato historico.
ALTER TABLE tz_comprobantes DROP CONSTRAINT IF EXISTS tz_comprobantes_created_by_fkey;
DROP TRIGGER IF EXISTS tz_comprobantes_inmutables ON tz_comprobantes;
CREATE TRIGGER tz_comprobantes_inmutables BEFORE UPDATE OR DELETE ON tz_comprobantes
  FOR EACH ROW EXECUTE FUNCTION tz_bloquear_comprobantes();

CREATE OR REPLACE FUNCTION tz_bloquear_huellas() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Las huellas no se pueden borrar.';
  END IF;
  IF NEW.id_centro IS DISTINCT FROM OLD.id_centro OR NEW.tipo <> OLD.tipo OR NEW.ref_id <> OLD.ref_id
     OR NEW.version <> OLD.version OR NEW.huella_dato <> OLD.huella_dato OR NEW.huella_prev <> OLD.huella_prev
     OR NEW.huella <> OLD.huella OR NEW.fecha_sello <> OLD.fecha_sello OR NEW.creado <> OLD.creado
     OR (OLD.prueba IS NOT NULL AND NEW.prueba IS DISTINCT FROM OLD.prueba) THEN
    RAISE EXCEPTION 'Las huellas son inmutables (solo se puede agregar su prueba Merkle una vez).';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tz_huellas_inmutables ON tz_huellas;
CREATE TRIGGER tz_huellas_inmutables BEFORE UPDATE OR DELETE ON tz_huellas
  FOR EACH ROW EXECUTE FUNCTION tz_bloquear_huellas();

-- La raiz y el archivo de un sello diario no cambian; solo avanzan el .ots y su estado.
CREATE OR REPLACE FUNCTION tz_bloquear_sellos() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Los sellos diarios no se pueden borrar.';
  END IF;
  IF NEW.fecha <> OLD.fecha OR NEW.raiz <> OLD.raiz OR NEW.total <> OLD.total OR NEW.archivo <> OLD.archivo THEN
    RAISE EXCEPTION 'La raiz de un sello diario es inmutable.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tz_sellos_inmutables ON tz_sellos_diarios;
CREATE TRIGGER tz_sellos_inmutables BEFORE UPDATE OR DELETE ON tz_sellos_diarios
  FOR EACH ROW EXECUTE FUNCTION tz_bloquear_sellos();

-- Sello diario por asociacion (utils/selloDia.js): copia congelada de los datos transaccionales
-- del dia de cada centro, con su huella encadenada. Si un dia sellado cambia despues, se sella una
-- version nueva con el detalle de los cambios y el motivo; las versiones anteriores no se borran.
CREATE TABLE IF NOT EXISTS tz_sellos_asociacion (
  id BIGSERIAL PRIMARY KEY,
  id_centro INT NOT NULL,
  fecha DATE NOT NULL,
  version INT NOT NULL,
  datos JSONB NOT NULL,
  cambios JSONB,
  motivo TEXT,
  codigo VARCHAR(40) NOT NULL,
  huella CHAR(64),
  creado TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (id_centro, fecha, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS tz_sellos_asociacion_codigo_idx ON tz_sellos_asociacion (codigo) WHERE codigo <> 'pendiente';

-- Motivos que da el usuario al cambiar un dia ya sellado (se adjuntan a la siguiente version).
CREATE TABLE IF NOT EXISTS tz_cambios_sellados (
  id BIGSERIAL PRIMARY KEY,
  id_centro INT NOT NULL,
  fecha DATE NOT NULL,
  motivo TEXT NOT NULL,
  accion VARCHAR(60),
  user_id INT,
  usuario VARCHAR(150),
  creado TIMESTAMPTZ DEFAULT NOW()
);
-- Sin llave foranea a users: borrar un usuario no debe tocar este historial inmutable.
ALTER TABLE tz_cambios_sellados DROP CONSTRAINT IF EXISTS tz_cambios_sellados_user_id_fkey;
ALTER TABLE tz_cambios_sellados ADD COLUMN IF NOT EXISTS usuario VARCHAR(150);
CREATE INDEX IF NOT EXISTS tz_cambios_sellados_idx ON tz_cambios_sellados (id_centro, fecha);

CREATE OR REPLACE FUNCTION tz_bloquear_sellos_asociacion() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Los sellos diarios de una asociacion no se pueden borrar.';
  END IF;
  -- Solo se permite completar el codigo y la huella una vez, justo despues de crearlo.
  IF OLD.huella IS NOT NULL OR NEW.id_centro <> OLD.id_centro OR NEW.fecha <> OLD.fecha OR NEW.version <> OLD.version
     OR NEW.datos::text <> OLD.datos::text OR NEW.cambios::text IS DISTINCT FROM OLD.cambios::text
     OR NEW.motivo IS DISTINCT FROM OLD.motivo OR NEW.creado <> OLD.creado THEN
    RAISE EXCEPTION 'Los sellos diarios de una asociacion son inmutables.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tz_sellos_asociacion_inmutables ON tz_sellos_asociacion;
CREATE TRIGGER tz_sellos_asociacion_inmutables BEFORE UPDATE OR DELETE ON tz_sellos_asociacion
  FOR EACH ROW EXECUTE FUNCTION tz_bloquear_sellos_asociacion();

CREATE OR REPLACE FUNCTION tz_bloquear_cambios_sellados() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'El historial de motivos no se puede modificar ni borrar.';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tz_cambios_sellados_inmutables ON tz_cambios_sellados;
CREATE TRIGGER tz_cambios_sellados_inmutables BEFORE UPDATE OR DELETE ON tz_cambios_sellados
  FOR EACH ROW EXECUTE FUNCTION tz_bloquear_cambios_sellados();

-- Hora y autor de cada registro de balance de masas (entran en el sello diario). creado_en se
-- conserva aunque el registro se edite; modificado_en/por guardan la ultima modificacion.
-- origen: 'manual' (pantalla), 'importacion' (Excel subido a mano) o 'carga_programada'.
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS creado_en TIMESTAMPTZ;
UPDATE tz_formulario_balance_masas SET creado_en = created_at AT TIME ZONE 'UTC' WHERE creado_en IS NULL;
ALTER TABLE tz_formulario_balance_masas ALTER COLUMN creado_en SET DEFAULT NOW();
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS creado_por INT;
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS modificado_en TIMESTAMPTZ;
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS modificado_por INT;
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS origen VARCHAR(20) DEFAULT 'manual';
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS id_carga BIGINT;

-- Cargas masivas programadas: el archivo se sube y valida de inmediato, y se aplica solo a la hora
-- programada. Queda registro publico (para la SSPD) de cuando se subio, su huella y cuando se aplico.
CREATE TABLE IF NOT EXISTS tz_cargas_programadas (
  id BIGSERIAL PRIMARY KEY,
  entidad VARCHAR(40) NOT NULL,
  archivo_nombre TEXT NOT NULL,
  archivo BYTEA NOT NULL,
  archivo_sha256 CHAR(64) NOT NULL,
  filas_validas INT NOT NULL DEFAULT 0,
  filas_omitidas INT NOT NULL DEFAULT 0,
  errores JSONB,
  programada_para TIMESTAMPTZ NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'programada', -- programada | ejecutando | ejecutada | error | cancelada
  subido_por INT,
  subido_en TIMESTAMPTZ DEFAULT NOW(),
  ejecutada_en TIMESTAMPTZ,
  cancelada_en TIMESTAMPTZ,
  resultado JSONB
);
CREATE INDEX IF NOT EXISTS tz_cargas_programadas_pend_idx ON tz_cargas_programadas (estado, programada_para);

-- Compras anexadas: cuando un reciclador vuelve el mismo dia, lo nuevo se SUMA a su registro del dia
-- (cantidad, rechazo y no SUI; valor/kg queda como promedio ponderado). Aqui queda cada compra
-- anexada por separado, con su hora, para poder reconstruir el detalle.
CREATE TABLE IF NOT EXISTS tz_balance_anexos (
  id BIGSERIAL PRIMARY KEY,
  id_centro INT NOT NULL,
  id_reciclador INT NOT NULL,
  fecha DATE NOT NULL,
  materiales JSONB NOT NULL,
  user_id INT,
  creado TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tz_balance_anexos_idx ON tz_balance_anexos (id_reciclador, fecha);

-- Asociaciones de prueba: solo en ellas se permite la simulacion de cargas por hora. Sus datos se
-- muestran en la consulta publica como "datos de prueba".
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS es_prueba BOOLEAN DEFAULT FALSE;
UPDATE tz_centros SET es_prueba = TRUE WHERE cod_centro = 'DEMO-01' AND es_prueba IS NOT TRUE;

-- Simulacion de cargas por hora (solo asociaciones de prueba): cada fila del archivo entra sola a la
-- hora indicada en su columna Hora. Las filas quedan con origen 'simulacion'.
ALTER TABLE tz_cargas_programadas ADD COLUMN IF NOT EXISTS modo VARCHAR(20) DEFAULT 'completa'; -- completa | simulacion
CREATE TABLE IF NOT EXISTS tz_cargas_filas (
  id BIGSERIAL PRIMARY KEY,
  id_carga BIGINT NOT NULL,
  fila JSONB NOT NULL,
  aplicar_en TIMESTAMPTZ NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente', -- pendiente | aplicada | omitida | cancelada
  resultado TEXT,
  aplicada_en TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tz_cargas_filas_pend_idx ON tz_cargas_filas (estado, aplicar_en);

-- ============================================================================================
-- Sistema de usuarios (replica del sistema anterior en ASP.NET): perfiles, menu, submenu y
-- opciones por perfil. Los ids y codigos son los mismos del sistema viejo. El perfil ADM ve todo
-- (no necesita opciones); ADM_CENTROS (equipo Genesis) ve todas las asociaciones pero solo las
-- opciones marcadas; USUARIOS y EMPLEADOS solo su asociacion. "clave" = pantalla del sistema nuevo.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS gt_perfiles (
  id SERIAL PRIMARY KEY,
  cod_perfil VARCHAR(30) UNIQUE NOT NULL,
  desc_perfil VARCHAR(120) NOT NULL,
  todas_asociaciones BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO gt_perfiles (id, cod_perfil, desc_perfil, todas_asociaciones) VALUES
  (1, 'ADM', 'Administrador', TRUE),
  (8, 'ADM_CENTROS', 'Administrador todos los centros', TRUE),
  (9, 'USUARIOS', 'Usuarios', FALSE),
  (25, 'EMPLEADOS', 'Empleados', FALSE)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('gt_perfiles', 'id'), GREATEST((SELECT MAX(id) FROM gt_perfiles), 25));

CREATE TABLE IF NOT EXISTS gt_menu (
  id SERIAL PRIMARY KEY,
  cod_item INT NOT NULL,
  descripcion VARCHAR(120) NOT NULL,
  clave VARCHAR(60)
);
INSERT INTO gt_menu (id, cod_item, descripcion, clave) VALUES
  (1, 10, 'Inicio', 'inicio'),
  (2, 20, 'Tablas De Referencia', NULL),
  (16, 21, 'Documentos', NULL),
  (15, 30, 'Usuarios', NULL),
  (12, 31, 'Formularios', NULL),
  (13, 40, 'Importar Datos', NULL),
  (17, 50, 'Resumenes', NULL),
  (14, 90, 'Salir', 'salir')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('gt_menu', 'id'), GREATEST((SELECT MAX(id) FROM gt_menu), 17));

CREATE TABLE IF NOT EXISTS gt_submenu (
  id SERIAL PRIMARY KEY,
  id_menu INT NOT NULL REFERENCES gt_menu(id) ON DELETE CASCADE,
  cod_item INT NOT NULL,
  descripcion VARCHAR(120) NOT NULL,
  clave VARCHAR(60) NOT NULL
);
INSERT INTO gt_submenu (id, id_menu, cod_item, descripcion, clave) VALUES
  (69, 2, 100, 'Perfiles Acceso', 'perfiles'),
  (68, 2, 200, 'Items Menu', 'menu'),
  (70, 2, 300, 'Estados', 'estados'),
  (75, 2, 400, 'Colaboradores', 'colaboradores'),
  (77, 2, 500, 'Calendario', 'calendario'),
  (79, 2, 600, 'Asociaciones', 'centros'),
  (81, 2, 701, 'Numacros Asociaciones/Localidades', 'numacros'),
  (82, 2, 702, 'Localidades', 'localidades'),
  (80, 2, 703, 'Tipos Materiales', 'tipos_material'),
  (97, 2, 703, 'Ciudades', 'ciudades'),
  (98, 2, 704, 'Nuaps', 'nuaps'),
  (83, 2, 800, 'Recicladores', 'recicladores'),
  (86, 2, 850, 'Tipos microrrutas', 'tipos_microrrutas'),
  (111, 2, 851, 'Conceptos pagos tarifas', 'conceptos_pago_tarifa'),
  (116, 2, 852, 'Conceptos pagos seguridad', 'conceptos_pago_seguridad'),
  (117, 2, 853, 'Operadores', 'operadores'),
  (85, 2, 900, 'Lista cargues-Balance masas', 'cargues_balance_masas'),
  (100, 2, 901, 'Lista cargues-Aprovechamiento', 'cargues_aprovechamiento'),
  (101, 2, 902, 'Lista cargues-Usuarios', 'cargues_usuarios'),
  (109, 2, 903, 'Lista cargues-Ventas', 'cargues_ventas'),
  (113, 2, 904, 'Lista cargues-Pago tarifas', 'cargues_pago_tarifa'),
  (115, 2, 905, 'Lista cargues-Pago seguridad', 'cargues_pago_seguridad'),
  (84, 2, 999, 'Cambio Password', 'cambio_password'),
  (105, 16, 100, 'Lista documentos', 'lista_documentos'),
  (106, 16, 200, 'Documentos asociaciones', 'documentos_asociaciones'),
  (119, 16, 300, 'Documentos referencia', 'documentos_referencia'),
  (89, 15, 200, 'Usuario uso', 'usuario_uso'),
  (90, 15, 300, 'Usuario tipo', 'usuario_tipo'),
  (91, 15, 400, 'Usuario Multiusuario', 'usuario_multiusuario'),
  (92, 15, 500, 'Usuario aforado', 'usuario_aforado'),
  (93, 15, 600, 'Usuario ubicación', 'usuario_ubicacion'),
  (94, 15, 700, 'Usuario clase de uso', 'usuario_clase_uso'),
  (95, 15, 800, 'Usuario tipo de aforo', 'usuario_tipo_aforo'),
  (96, 15, 900, 'Usuarios', 'usuarios'),
  (74, 12, 1, 'Formulario Balance de Masas', 'balance_masas'),
  (87, 12, 2, 'Formulario Microrrutas', 'microrrutas'),
  (99, 12, 3, 'Formulario aforados aprovechamiento', 'aprovechamiento'),
  (112, 12, 4, 'Formulario pago tarifas', 'pago_tarifa'),
  (114, 12, 5, 'Formulario pago seguridad', 'pago_seguridad'),
  (118, 12, 6, 'Formulario recursos', 'recursos'),
  (78, 13, 100, 'Importar datos de excel', 'importar'),
  (107, 17, 100, 'Resumen formulario masas', 'resumen_masas'),
  (108, 17, 200, 'Dashboard', 'dashboard'),
  (110, 17, 200, 'SQL archivos locales', 'sql_archivos')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('gt_submenu', 'id'), GREATEST((SELECT MAX(id) FROM gt_submenu), 119));

CREATE TABLE IF NOT EXISTS gt_perfil_opciones (
  id_perfil INT NOT NULL REFERENCES gt_perfiles(id) ON DELETE CASCADE,
  id_submenu INT NOT NULL REFERENCES gt_submenu(id) ON DELETE CASCADE,
  PRIMARY KEY (id_perfil, id_submenu)
);
-- Semilla solo la primera vez (si el perfil ya tiene opciones, se respeta lo que edito el administrador).
INSERT INTO gt_perfil_opciones (id_perfil, id_submenu)
SELECT 8, s FROM unnest(ARRAY[75,77,79,80,81,82,74,84,83,78,85,86,87,105,106,108,109,107,100,113,115,111,116,112,114,97,98,89,90,91,92,93,94,95,96,118,117]) s
WHERE NOT EXISTS (SELECT 1 FROM gt_perfil_opciones WHERE id_perfil = 8)
ON CONFLICT DO NOTHING;
INSERT INTO gt_perfil_opciones (id_perfil, id_submenu)
SELECT 9, s FROM unnest(ARRAY[74,84,83,87,96,78,99,85,101,100,106,108,107,113,115,112,114,118]) s
WHERE NOT EXISTS (SELECT 1 FROM gt_perfil_opciones WHERE id_perfil = 9)
ON CONFLICT DO NOTHING;
INSERT INTO gt_perfil_opciones (id_perfil, id_submenu)
SELECT 25, s FROM unnest(ARRAY[74]) s
WHERE NOT EXISTS (SELECT 1 FROM gt_perfil_opciones WHERE id_perfil = 25)
ON CONFLICT DO NOTHING;

-- Perfil y bloqueo de ingreso por usuario (como colaboradores.id_perfil / id_estado /
-- msg_login_desactivado del sistema viejo).
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_perfil INT REFERENCES gt_perfiles(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS msg_login_desactivado TEXT;
ALTER TABLE users ALTER COLUMN id_perfil SET DEFAULT 9;
UPDATE users SET id_perfil = CASE role WHEN 'pro' THEN 1 WHEN 'admin' THEN 8 ELSE 9 END WHERE id_perfil IS NULL;

-- Centro de trazabilidad de cada asociacion del sistema de usuarios. modulo = 'pruebas' (con sello
-- diario / cadena de integridad) o 'sistema' (sin sello: la cadena de integridad queda solo en Pruebas).
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS association_id INT REFERENCES associations(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tz_centros_association_uidx ON tz_centros (association_id) WHERE association_id IS NOT NULL;
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS modulo VARCHAR(20) NOT NULL DEFAULT 'pruebas';

-- ASORETRIP (Asociacion de Recicladores de Bogota El Triunfo, associations.id 7): asociacion de prueba
-- del sistema de usuarios. Codigo 992 = el mismo del sistema viejo.
INSERT INTO tz_centros (cod_centro, desc_centro, nit, association_id, modulo)
SELECT '992', 'ASORETRIP', a.nit, a.id, 'sistema' FROM associations a
WHERE a.id = 7 AND NOT EXISTS (SELECT 1 FROM tz_centros WHERE association_id = 7 OR cod_centro = '992');

-- Enlace del dashboard de cada asociacion (Resumenes > Dashboard), como centros.link_dashboard.
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS link_dashboard TEXT;

-- El menu queda identico al sistema viejo: se quitan las opciones que no tenia (ECA, macrorrutas,
-- areas de prestacion; esas tablas se manejan desde Pruebas) ...
DELETE FROM gt_submenu WHERE id IN (120, 121, 122);
-- ... y los nombres vuelven a ser los del sistema viejo (solo si siguen con el nombre provisional,
-- para no pisar lo que el administrador cambie en "Items Menu").
UPDATE gt_menu m SET descripcion = v.nuevo FROM (VALUES
  (2, 'Tablas de referencia', 'Tablas De Referencia'), (13, 'Importar datos', 'Importar Datos'), (17, 'Resúmenes', 'Resumenes')
) AS v(id, antes, nuevo) WHERE m.id = v.id AND m.descripcion = v.antes;
UPDATE gt_submenu s SET descripcion = v.nuevo FROM (VALUES
  (69, 'Perfiles acceso', 'Perfiles Acceso'), (68, 'Items menú', 'Items Menu'), (79, 'Asociaciones', 'Asociaciones'),
  (81, 'Numacros asociaciones/localidades', 'Numacros Asociaciones/Localidades'), (80, 'Tipos materiales', 'Tipos Materiales'),
  (84, 'Cambio password', 'Cambio Password'), (91, 'Usuario multiusuario', 'Usuario Multiusuario'),
  (74, 'Formulario balance de masas', 'Formulario Balance de Masas'), (87, 'Formulario microrrutas', 'Formulario Microrrutas'),
  (78, 'Importar datos de Excel', 'Importar datos de excel')
) AS v(id, antes, nuevo) WHERE s.id = v.id AND s.descripcion = v.antes;

-- Cargues masivos del sistema de usuarios (Importar datos de Excel / Lista cargues-*): cada archivo
-- queda registrado y sus filas llevan id_cargue, para listarlo o borrarlo completo.
CREATE TABLE IF NOT EXISTS gt_cargues (
  id BIGSERIAL PRIMARY KEY,
  tipo VARCHAR(40) NOT NULL,
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  archivo VARCHAR(255),
  filas INT NOT NULL DEFAULT 0,
  user_id INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS id_cargue BIGINT;
ALTER TABLE tz_formulario_aprovechamiento ADD COLUMN IF NOT EXISTS id_cargue BIGINT;
ALTER TABLE tz_usuarios ADD COLUMN IF NOT EXISTS id_cargue BIGINT;
ALTER TABLE tz_formulario_ventas ADD COLUMN IF NOT EXISTS id_cargue BIGINT;
ALTER TABLE tz_formulario_pago_tarifa ADD COLUMN IF NOT EXISTS id_cargue BIGINT;
ALTER TABLE tz_formulario_pago_seguridad ADD COLUMN IF NOT EXISTS id_cargue BIGINT;
ALTER TABLE tz_formulario_recursos ADD COLUMN IF NOT EXISTS id_cargue BIGINT;
ALTER TABLE tz_recicladores ADD COLUMN IF NOT EXISTS id_cargue BIGINT;
CREATE INDEX IF NOT EXISTS tz_bm_id_cargue_idx ON tz_formulario_balance_masas (id_cargue) WHERE id_cargue IS NOT NULL;

-- Documentos: tipos (Lista documentos = catalogo tipos_documento_asociacion), documentos de cada
-- asociacion (uno por tipo, con vigencia) y documentos de referencia (generales).
INSERT INTO tz_catalogos (categoria, codigo, descripcion, orden) VALUES
  ('tipos_documento_asociacion', '001', 'CAMARA DE COMERCIO', 1), ('tipos_documento_asociacion', '002', 'RUT', 2),
  ('tipos_documento_asociacion', '003', 'ESTATUTOS', 3), ('tipos_documento_asociacion', '004', 'CEDULA REPRESENTANTE LEGAL', 4),
  ('tipos_documento_asociacion', '005', 'ACTA DE CONSTITUCION', 5), ('tipos_documento_asociacion', '006', 'RUPS', 6),
  ('tipos_documento_asociacion', '007', 'CONTRATO DE CONDICIONES UNIFORMES CCU', 7), ('tipos_documento_asociacion', '008', 'CONCEPTO DE LEGALIDAD DE LA CRA', 8),
  ('tipos_documento_asociacion', '009', 'RESOLUCION DE FACTURACION', 9), ('tipos_documento_asociacion', '010', 'RESOLUCION DOCUMENTO SOPORTE', 10),
  ('tipos_documento_asociacion', '011', 'CERTIFICADO CALIBRACION DE BASCULAS', 11), ('tipos_documento_asociacion', '012', 'REGISTRO DE ESTACION DE CLASIFICACION Y ALMACENAMIENTO (ECA)', 12),
  ('tipos_documento_asociacion', '014', 'RELACION DE MIEMBROS', 14), ('tipos_documento_asociacion', '015', 'DIAGRAMA DE FLUJO', 15),
  ('tipos_documento_asociacion', '016', 'REGISTRO DE RUES', 16), ('tipos_documento_asociacion', '017', 'USO DE SUELOS', 17),
  ('tipos_documento_asociacion', '018', 'SANIDAD', 18), ('tipos_documento_asociacion', '019', 'BOMBEROS', 19),
  ('tipos_documento_asociacion', '020', 'PLAN DE SANEAMIENTO', 20), ('tipos_documento_asociacion', '021', 'PLAN DE EMERGENCIA Y CONTINGENCIA', 21),
  ('tipos_documento_asociacion', '022', 'PLAN DE LIMPIEZA Y DESINFECCION', 22), ('tipos_documento_asociacion', '023', 'LAVADO DE TANQUES', 23),
  ('tipos_documento_asociacion', '024', 'CONTROL DE PLAGAS', 24), ('tipos_documento_asociacion', '025', 'RECIBO PUBLICO', 25)
ON CONFLICT (categoria, codigo) DO NOTHING;
INSERT INTO tz_catalogos (categoria, codigo, descripcion, orden) VALUES
  ('ciudades', '000', 'No aplica', 0), ('ciudades', '001', 'BOGOTA', 1), ('ciudades', '002', 'FUNZA', 2),
  ('ciudades', '003', 'MADRID', 3), ('ciudades', '004', 'MELGAR', 4)
ON CONFLICT (categoria, codigo) DO NOTHING;

CREATE TABLE IF NOT EXISTS gt_documentos (
  id SERIAL PRIMARY KEY,
  grupo VARCHAR(20) NOT NULL,                 -- asociacion | referencia
  id_centro INT REFERENCES tz_centros(id) ON DELETE CASCADE,
  id_tipo INT REFERENCES tz_catalogos(id),    -- solo grupo asociacion
  nombre VARCHAR(255) NOT NULL,               -- nombre del documento (referencia) o del archivo
  archivo_url TEXT NOT NULL,
  vigencia DATE,
  user_id INT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS gt_documentos_asoc_uidx ON gt_documentos (id_centro, id_tipo) WHERE grupo = 'asociacion';

-- NUAP por asociacion y ciudad (como la tabla nuaps del sistema viejo).
CREATE TABLE IF NOT EXISTS tz_nuaps (
  id SERIAL PRIMARY KEY,
  id_centro INT NOT NULL REFERENCES tz_centros(id) ON DELETE CASCADE,
  id_ciudad INT REFERENCES tz_catalogos(id),
  cod_nuap VARCHAR(30) NOT NULL,
  UNIQUE (cod_nuap)
);

-- Facturas del sistema de usuarios: se guardan en tz_comprobantes (para que el QR abra la factura)
-- pero sin huella ni sello: la cadena de integridad queda solo en Pruebas.
ALTER TABLE tz_comprobantes ADD COLUMN IF NOT EXISTS sin_cadena BOOLEAN NOT NULL DEFAULT FALSE;

-- Rechazo estimado (sistema de usuarios): si el usuario no escribe el rechazo de un material, se
-- calcula el porcentaje fijo de la asociacion sobre los kilos recibidos y la fila queda marcada.
ALTER TABLE tz_formulario_balance_masas ADD COLUMN IF NOT EXISTS rechazo_estimado BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tz_centros ADD COLUMN IF NOT EXISTS pct_rechazo_estimado NUMERIC(5,2);
UPDATE tz_centros SET pct_rechazo_estimado = 1.8 WHERE modulo = 'sistema' AND pct_rechazo_estimado IS NULL;

-- Precios fijos de material por asociacion (Tablas De Referencia > Precios materiales): el formulario
-- de balance de masas los pone solos al escribir los kilos, pero se pueden cambiar en cada compra.
CREATE TABLE IF NOT EXISTS gt_precios_material (
  id_centro INT NOT NULL REFERENCES tz_centros(id) ON DELETE CASCADE,
  id_tipo_material INT NOT NULL REFERENCES tz_tipos_material(id) ON DELETE CASCADE,
  precio NUMERIC(14,2) NOT NULL CHECK (precio >= 0),
  user_id INT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (id_centro, id_tipo_material)
);
WITH nuevo AS (
  INSERT INTO gt_submenu (id, id_menu, cod_item, descripcion, clave)
  VALUES (123, 2, 703, 'Precios materiales', 'precios_material')
  ON CONFLICT (id) DO NOTHING RETURNING id
)
INSERT INTO gt_perfil_opciones (id_perfil, id_submenu)
SELECT p.id, n.id FROM nuevo n CROSS JOIN (VALUES (8), (9)) AS p(id)
ON CONFLICT DO NOTHING;
