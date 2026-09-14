# Genesis Traza - Backend

Backend real: registro con verificación por correo, planes editables, pagos con Wompi,
panel administrador (roles pro/admin), logs de actividad y errores, recordatorios de pago automáticos.

## 1. Cuentas que debes crear (gratis para empezar)

1. **Railway** (railway.app) — aquí vive el servidor y la base de datos PostgreSQL.
2. **Resend** (resend.com) — para enviar los correos con el código de verificación. Plan gratis: 3.000 correos/mes.
3. **Wompi Comercios** (comercios.wompi.co) — la pasarela de pagos. Regístrate con tu cédula/RUT y cuenta Bancolombia o Nequi.

## 2. Consigue tus llaves

- En Railway, crea un proyecto nuevo → "Add PostgreSQL" → copia el valor `DATABASE_URL` que te genera.
- En Resend, ve a "API Keys" → crea una → copia el valor que empieza por `re_`.
- En Wompi, ve a "Desarrolladores" → copia tu `Llave pública`, `Secreto de integridad` y `Secreto de eventos`.

## 3. Configura el proyecto

1. Copia `.env.example` y renómbralo a `.env`.
2. Pega ahí cada llave que conseguiste en el paso 2.
3. Instala las dependencias:
   ```
   npm install
   ```
4. Crea las tablas en tu base de datos:
   ```
   npm run migrate
   ```
   (esto también carga los planes de trazabilidad, facturación y combo que ya definimos).

## 4. Pruébalo en tu computador

```
npm start
```
Debe decir "Genesis Traza backend corriendo en puerto 3000". Abre `http://localhost:3000/health` y debe responder `{"ok":true}`.

## 5. Despliega a Railway (para que quede accesible por internet)

1. Sube este proyecto a un repositorio de GitHub (crea uno vacío en github.com y sigue las instrucciones para subir estos archivos).
2. En Railway, "New Project" → "Deploy from GitHub repo" → selecciona el repositorio.
3. En "Variables", pega las mismas variables de tu archivo `.env`.
4. Railway te da una URL pública (algo como `genesis-traza-backend.up.railway.app`).

## 6. Conecta el webhook de Wompi

En el panel de Wompi, en "Eventos", pega:
```
https://TU-URL-DE-RAILWAY/payments/webhook
```
Así Wompi le avisa al sistema cuando un pago fue aprobado.

## 7. Crea tu usuario "pro" (control total)

Por seguridad, el primer usuario con rol `pro` se crea directo en la base de datos (no desde un formulario público). En Railway, abre la pestaña "Data" de tu base PostgreSQL y ejecuta:

```sql
UPDATE users SET role = 'pro' WHERE email = 'tu-correo@ejemplo.com';
```
(primero regístrate normal desde el formulario de la web, verifica tu correo, y luego corres ese UPDATE con tu correo).

## 8. Conecta la landing (index.html) a este backend

En tu `index.html`, los formularios de registro, login y planes deben apuntar a la URL de Railway
en vez de tener las contraseñas escritas directamente en el código, como hoy. Este es el paso que
haremos en Claude Code al final, para reemplazar el login "fijo" actual por uno real y seguro.

## Estructura del proyecto

```
genesis-backend/
  server.js              -> arranca todo
  db/schema.sql           -> todas las tablas + planes iniciales
  db/migrate.js           -> corre el schema.sql
  routes/auth.js          -> registro, código por correo, login
  routes/plans.js         -> ver/crear/editar/desactivar planes (solo rol pro)
  routes/admin.js         -> asociaciones, pagos, logs, crear sub-admins
  routes/payments.js      -> crear pago con Wompi + recibir confirmación
  jobs/paymentReminders.js -> recordatorio automático 3 días antes del vencimiento
```
