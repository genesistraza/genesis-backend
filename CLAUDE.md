# Genesis Traza — contexto para Claude Code

Responde en **español**, corto y directo. El usuario (Cristian, fundador, no es desarrollador) da órdenes breves e informales: interpreta con generosidad, actúa y verifica. Si dice "hazlo todo", no vuelvas a preguntar; pregunta solo cuando equivocarse sale caro.

## Qué es
Software para asociaciones de recicladores / prestadores de aseo en Colombia: (1) Trazabilidad (SUI, balance de masas, etc.) y (2) Facturación electrónica DIAN (producto aparte: FacturaGenesis).

## Arquitectura y despliegue
- **Backend** Node/Express + PostgreSQL en Railway: `https://genesis-backend-production-edc7.up.railway.app` (repo GitHub `genesistraza/genesis-backend`, rama `main`, deploy automático). Correo con Resend, pagos con Wompi, archivos en Cloudinary.
- **Frontend** estático en `public/`, desplegado por Netlify desde `main` en **genesistraza.com** (sin guion). La "Production visibility" de Netlify debe quedar en **Public**.
- **genesis-traza.com (con guion) es otro sistema: nunca tocarlo.**
- Código: `server.js`, `routes/` (auth, admin, plans, payments, subscriptions, trazabilidad, massBalance, comprobantes, news), `db/` (schema.sql, migrate.js, pool.js), `jobs/` (cron recordatorio de pagos, noticias), `utils/` (trazaValidate.js, planillaPdf.js), `public/app.js` (helpers de sesión: `gtRequireAuth`, `gtApiFetch`, `gtLogout`).
- Páginas con nombre no adivinable a propósito: `public/admin-1b98a0bb3a.html`, `public/pruebas-437ce78188.html`. No volver a nombres genéricos.
- Scripts: `npm start`, `npm run migrate`, `npm run seed:demo` (asociación demo `DEMO-01`).

## Decisiones fijas (no cambiar sin preguntar)
- Pasarela Wompi; pago mensual obligatorio; sin login con Google (registro con código de 6 dígitos por correo).
- Roles: `pro` = Cristian (control total), `admin` = sub-admin operativo, `operativo` = usuario de asociación.
- Planes editables por `pro` desde el panel (semilla en `schema.sql`).
- Marca: azul #0B3D80/#1E6FD6, naranja #F2941F, verde #7AB72E; Poppins + Inter; recursos en `assets_marca/`.

## Reglas de trabajo
- **UI compacta** estilo sistema viejo: barra de título, menú horizontal por categorías con flyouts verticales (no `<select>`), sin párrafos largos.
- **PDF/imprimir solo para la factura diaria.** Los exportes al regulador (Excel/CSV) deben coincidir exactamente con el formato SUI (Anexo A del instructivo de aprovechamiento SSPD). NUMACRO = código de macrorruta; los campos codificados exportan el `codigo` del catálogo, no el id.
- **Nunca inventar ni estimar valores** en exportes regulatorios (p. ej. "rechazo" aleatorio): exigir el dato al capturar y avisar antes de exportar.
- Términos/códigos fijos (destino del rechazo en `tz_centros`, catálogos) son tareas del administrador, separadas del usuario.
- Fechas `'YYYY-MM-DD'`: nunca pasarlas por `new Date()` para mostrarlas (Bogotá UTC-5 muestra un día antes). `pool.js` devuelve DATE como texto.
- Validación central en `utils/trazaValidate.js` (create/update/import). En auditorías, buscar la clase completa de bug (validación, fechas, datos entre asociaciones, escapado), no solo el caso reportado.
- Botones de acciones en tablas: `<button>` real, no `<span onclick>`.
- **Pruebas:** `API_BASE` del frontend apunta al backend de Railway incluso desde localhost, así que cambios de backend hay que hacer push/deploy antes de probar en navegador. Para páginas pro, crear usuario `pro` + JWT desechable local y borrarlo después; limpiar scripts temporales y detener el servidor local.
- **Git:** `git status` antes de commitear y hacer `git add` con rutas explícitas. Mensaje de commit escrito con Write (verificar que el archivo no exista de antes; `Set-Content -Encoding utf8` agrega BOM).
- **Credenciales:** no escribir contraseñas en logins ni SSH; el usuario entra y pega la salida. No guardar ni repetir contraseñas, tokens ni contenido de `.env`. Si pega un secreto, pedir que lo rote. `TABLA_ACCESOS_FACTURACION.csv` y `.env` están en `.gitignore`.

## Pendientes conocidos
- Wompi webhook reescrito pero **nunca probado con un pago real**: probar con sandbox antes de salir en vivo.
- Seguridad: NITs duplicados permitidos; `PUT /admin/associations` deja a sub-admins editar el enlace de facturación; sin recuperación de contraseña; `facturacion_url` no se valida como https; revisar IDOR en `POST /payments/create` (dueño de la suscripción + monto del lado servidor).
- SUI: faltan exportes oficiales de ECA, macrorrutas, usuarios, miembros, recursos, aforados, DINC, toneladas aprovechadas; falta entidad básculas; confirmar códigos DTGA de materiales.
- Tarjeta "Nuestros sistemas" (Trazabilidad + Facturación) es provisional.
- **Integración FacturaGenesis → Ventas** (esperando decisiones del usuario): facturas reales en `apidian.documents` (MariaDB en el VPS Contabo de FacturaGenesis, Docker). Plan propuesto: script cron en el servidor que lee documentos nuevos y los envía firmados con HMAC a un endpoint nuevo de genesistraza.com (upsert por CUFE, NIT → `associations.nit`). Falta: mapa NIT→asociación, aprobar el enfoque, qué hacer con los 8.523 docs del NIT 901326051.
- VPS FacturaGenesis: rotar contraseña root y pasar a llaves SSH; cerrar el puerto 3306 expuesto.
- **SSL de facturargenesis.com vence el 2026-12-20** (wildcard, emitido manual con certbot DNS-01 en Namecheap; no se renueva solo). Ya existe el recordatorio: tarea programada en la nube de la cuenta de Claude "Renovar certificado SSL facturargenesis.com", el 2026-12-01 a las 9:00 a. m. (no crear otra). Tras renovar hay que copiar `fullchain.pem`/`privkey.pem` a `/root/setup/certs/facturargenesis.com.crt|.key` y `docker exec proxy nginx -s reload`. Idealmente automatizar con API de Namecheap + acme.sh.
