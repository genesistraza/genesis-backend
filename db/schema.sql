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

CREATE TABLE IF NOT EXISTS error_logs (
  id SERIAL PRIMARY KEY,
  level VARCHAR(20) DEFAULT 'error',
  message TEXT NOT NULL,
  stack TEXT,
  route VARCHAR(150),
  created_at TIMESTAMP DEFAULT NOW()
);

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
