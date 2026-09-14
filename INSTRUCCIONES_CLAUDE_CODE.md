# Instrucciones para Claude Code - Proyecto Genesis Traza

Este documento resume TODO lo decidido en la conversación previa (en claude.ai) para que
Claude Code pueda continuar sin perder contexto. Pégalo como primer mensaje en Claude Code,
o dile "lee INSTRUCCIONES_CLAUDE_CODE.md antes de empezar".

## Qué es Genesis Traza

Software para asociaciones de recicladores y prestadores de servicios públicos en Colombia.
Dos módulos: (1) Trazabilidad — cargue al SUI, balance de masas, caracterización, vehículos,
reporte a Contraloría — y (2) Facturación electrónica ante la DIAN.

## Qué existe ya (y dónde)

1. **Landing estática** (`index.html`, adjunto en este mismo zip como `index.html`):
   ya publicada en Netlify, con dominio propio comprado en Wix apuntado por DNS.
   Tiene: hero, soluciones con "saber más", 3 pestañas de planes (trazabilidad/facturación/combo),
   sección Nosotros, FAQ, y dos logins que HOY son inseguros (credenciales fijas en el código
   JavaScript, visibles en "ver código fuente"):
   - "Facturación electrónica": redirige según una tabla fija de 7 asociaciones a subdominios
     de facturargenesis.com (ver `TABLA_ACCESOS_FACTURACION.csv` en este zip).
   - "Administrador": un único correo/clave fijo que redirige a facturargenesis.com.
   **Tarea pendiente:** reemplazar ambos por login real contra el backend (ver abajo).

2. **Backend Node/Express** (carpeta `genesis-backend/`, ya escrito pero NO desplegado aún):
   registro con verificación por código de correo (Resend), planes editables en base de datos,
   pagos con Wompi (creación + webhook con verificación de firma), recordatorio automático de
   pago 3 días antes del vencimiento (cron), panel admin (asociaciones, pagos, logs), roles
   `pro` / `admin` / `operativo`. Esquema completo en `genesis-backend/db/schema.sql`.
   El README de esa carpeta trae el paso a paso de despliegue en Railway.

## Decisiones ya tomadas (no las cambies sin preguntar)

- **Pasarela de pagos:** Wompi (Bancolombia). Elegida por: gratis para arrancar, buena
  compatibilidad con Nequi y tarjetas, comisión ~2.65% + $700 + IVA por transacción exitosa.
- **Pago:** obligatoriamente mensual (no hay plan sin pago).
- **Roles de usuario:**
  - `pro` = Cristian (el dueño/fundador). Control total: usuarios, planes, pagos, configuración,
    logs de actividad y de errores.
  - `admin` = sub-jefes/administradores. Rol netamente operativo (ven datos, no configuran).
  - `operativo` = usuario normal de cada asociación registrada.
- **Registro de usuarios:** formulario completo (nombre, asociación, NIT, correo, celular, etc.)
  + verificación por código de 6 dígitos enviado al correo. NO se usa login de Google (se descartó
  explícitamente).
- **Planes:** deben poder crearse/editarse desde el panel admin por el rol `pro` (ya implementado
  en `routes/plans.js`). Estructura actual (semilla ya cargada en `schema.sql`):
  - **Trazabilidad** (precio según N° de recicladores de la asociación): Hasta 20 → $150.000/mes;
    21 a 60 → $280.000/mes; Más de 60 → $400.000/mes.
  - **Facturación** (inspirados en Siigo pero más generosos en documentos y con prueba gratis de
    30 días): Básico $25.000/mes (80 documentos); Profesional $45.000/mes (300 documentos);
    Documentación ilimitada $89.000/mes.
  - **Combo** (trazabilidad + facturación con descuento): Combo Inicial $160.000/mes; Combo
    Crecimiento $295.000/mes; Combo Total $440.000/mes.
- **Dominio:** el usuario ya compró un dominio en Wix (genesis-traza.com) y sabe apuntar los DNS
  a un nuevo hosting; ya lo hizo una vez para Netlify.
- **Identidad visual:** paleta azul (#0B3D80 / #1E6FD6), naranja (#F2941F) y verde (#7AB72E),
  tipografías Poppins (títulos) e Inter (texto). Logo y mascota (robot) ya recortados en PNG
  transparente, incluidos en este zip en `assets_marca/`.
- **Nunca** se debe exponer contraseñas en texto plano en el frontend una vez esté el backend
  conectado — ese es justamente el problema que hay que resolver.

## Qué falta por hacer en Claude Code (en este orden sugerido)

1. Ayudar al usuario a crear las cuentas de Railway, Resend y Wompi (él las crea, tú lo guías
   paso a paso; no tienes forma de crearlas por él).
2. Desplegar `genesis-backend/` en Railway siguiendo su propio README.
3. Correr la migración (`npm run migrate`) para crear las tablas y cargar los planes.
4. Modificar `index.html` para que:
   - El formulario de "Facturación electrónica" llame a `POST /auth/login` del backend real,
     en vez de comparar contra el arreglo `CLIENT_ACCESS` fijo en el JS.
   - Se agregue un formulario de registro completo que llame a `POST /auth/register`, con
     pantalla de verificación por código que llame a `POST /auth/verify`.
   - Los planes de la sección `#planes` se carguen dinámicamente desde `GET /plans` en vez de
     estar escritos a mano en el HTML (así el admin los edita sin tocar código).
   - El botón "Continuar por WhatsApp" de `#pago` se reemplace por el flujo real de Wompi
     (usar `POST /payments/create` para abrir su widget de checkout).
5. Construir el panel de administrador como interfaz web (hoy solo existen los endpoints en
   `routes/admin.js`, falta la pantalla): tabla de asociaciones con estado de pago, tabla de
   pagos, logs de actividad, logs de errores, formulario para crear/editar planes, formulario
   para crear sub-administradores.
6. Conectar el webhook de Wompi a la URL pública de Railway (`/payments/webhook`).
7. Una vez todo probado, apuntar el dominio genesis-traza.com al backend/frontend definitivo.

## Preferencias del usuario (Cristian)

- Prefiere ser eficiente con recursos: hacer solo lo necesario, evitar pasos de más.
- Comunicación directa e informal.
- Prefiere ejecución inmediata sobre pasos de confirmación repetidos.
- Respuestas concisas y de alta señal.
- Es 20 años, trabaja en el sector de reciclaje y residuos sólidos en Bogotá, con varias
  asociaciones (Asoambiental, ASORETRIP, ECOACTIVA, Asomundo, entre otras) y su propia empresa
  de facturación electrónica (FacturaGenesis / facturargenesis.com).
