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
