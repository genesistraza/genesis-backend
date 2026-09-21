// Genesis Traza - helpers compartidos para dashboard.html y admin.html
var API_BASE = 'https://genesis-backend-production-edc7.up.railway.app';

function gtGetToken(){ return localStorage.getItem('gt_token'); }
function gtGetRole(){ return localStorage.getItem('gt_role'); }
function gtGetFullName(){ return localStorage.getItem('gt_fullName'); }

function gtLogout(reason){
  localStorage.removeItem('gt_token');
  localStorage.removeItem('gt_role');
  localStorage.removeItem('gt_fullName');
  localStorage.removeItem('gt_last_activity');
  window.location.href = 'index.html' + (reason ? '?session=' + reason : '');
}

// Redirige a index.html si no hay sesión, si el rol no está permitido en esta página, o si
// ya pasaron mas de 30 min desde la ultima actividad registrada. Este ultimo chequeo es lo
// que de verdad cierra la sesión cuando el usuario vuelve despues de dias: el temporizador de
// gtStartInactivityWatch solo corre mientras la pestaña sigue abierta, asi que cerrar el
// navegador (o el computador) lo detiene sin cerrar la sesión - por eso este chequeo tiene
// que hacerse tambien al cargar la pagina, no solo en el intervalo.
function gtRequireAuth(allowedRoles){
  var token = gtGetToken();
  var role = gtGetRole();
  if(!token || (allowedRoles && allowedRoles.indexOf(role) === -1)){
    window.location.href = 'index.html';
    return null;
  }
  var last = Number(localStorage.getItem('gt_last_activity') || 0);
  if(last && Date.now() - last > GT_INACTIVITY_LIMIT_MS){
    gtLogout('inactivity');
    return null;
  }
  gtStartInactivityWatch();
  return { token: token, role: role, fullName: gtGetFullName() };
}

// Cierra la sesión sola despues de 30 minutos sin actividad del usuario (mouse, teclado,
// scroll o toques), para que el panel no quede abierto indefinidamente en un equipo
// compartido. El ultimo momento de actividad se guarda en localStorage (no en una variable
// en memoria) para que funcione igual si hay varias pestañas abiertas del panel.
var GT_INACTIVITY_LIMIT_MS = 30 * 60 * 1000;
var gtInactivityWatchStarted = false;

function gtTouchActivity(){
  localStorage.setItem('gt_last_activity', String(Date.now()));
}

function gtStartInactivityWatch(){
  if(gtInactivityWatchStarted) return;
  gtInactivityWatchStarted = true;
  gtTouchActivity();
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach(function(evt){
    document.addEventListener(evt, gtTouchActivity, { passive: true });
  });
  setInterval(function(){
    if(!gtGetToken()) return;
    var last = Number(localStorage.getItem('gt_last_activity') || 0);
    if(Date.now() - last > GT_INACTIVITY_LIMIT_MS){
      gtLogout('inactivity');
    }
  }, 30000);
}

// Wrapper de fetch que agrega el token y maneja sesión expirada/errores de forma uniforme.
function gtApiFetch(path, options){
  options = options || {};
  var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  var token = gtGetToken();
  if(token) headers['Authorization'] = 'Bearer ' + token;
  return fetch(API_BASE + path, Object.assign({}, options, { headers: headers }))
    .then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(data){
        if(r.status === 401){ gtLogout('expired'); }
        return { ok: r.ok, status: r.status, data: data };
      });
    });
}

function gtEscapeHtml(v){
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function(c){
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Iniciales de la asociacion (maximo 2 letras) para el avatar cuando todavia no tiene logo.
function gtAssocInitials(name){
  var words = String(name || '').replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9 ]/g, ' ').split(/\s+/).filter(function(w){ return w.length > 2 || /^\d/.test(w); });
  var letters = (words.length ? words : String(name || '?').split(/\s+/)).slice(0, 2).map(function(w){ return w.charAt(0); }).join('');
  return (letters || '?').toUpperCase();
}

// HTML del logo de una asociacion ({name, logo_url}) o, sin logo, un avatar con sus iniciales.
// size: '' (52px), 'sm' (32px) o 'lg' (96px). Se usa igual en el dashboard, el panel admin y Pruebas.
function gtAssocLogoHtml(assoc, size){
  var cls = 'assoc-logo' + (size ? ' ' + size : '');
  if(assoc && assoc.logo_url){
    return '<span class="' + cls + '"><img src="' + gtEscapeHtml(assoc.logo_url) + '" alt="Logo de ' + gtEscapeHtml(assoc.name) + '" loading="lazy"></span>';
  }
  return '<span class="' + cls + ' initials" aria-hidden="true">' + gtEscapeHtml(gtAssocInitials(assoc && assoc.name)) + '</span>';
}

function gtFormatCOP(value){
  return '$' + Number(value || 0).toLocaleString('es-CO');
}

function gtTogglePwd(btn){
  var input = btn.previousElementSibling;
  if(!input) return;
  var show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
}

function gtToggleSidebar(){
  var sidebar = document.getElementById('sidebar');
  var backdrop = document.getElementById('sidebarBackdrop');
  if(sidebar) sidebar.classList.toggle('open');
  if(backdrop) backdrop.classList.toggle('open');
}

function gtFormatDate(value){
  if(!value) return '—';
  var s = String(value);
  // Una fecha sin hora ('YYYY-MM-DD', o medianoche UTC) es un dia de calendario: se arma con sus
  // componentes para que en Colombia (UTC-5) no se vea un dia antes. Con hora real, se convierte normal.
  var m = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/.exec(s);
  var d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  if(isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-CO', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Hoy en Colombia como 'YYYY-MM-DD' (toISOString da el dia de Londres: despues de las 7 p. m.
// ya seria "manana").
function gtTodayCO(){
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

// Ordena una lista de recicladores (con toneladas_mes/pago_mes/nombre_completo) segun uno de
// los valores del selector "Ordenar por" del dashboard/panel. Compartido entre dashboard.html
// y admin.html para que el criterio de orden sea exactamente el mismo en los dos.
function gtSortRecicladores(list, sortBy){
  var sorted = list.slice();
  if(sortBy === 'toneladas_desc') sorted.sort(function(a,b){ return Number(b.toneladas_mes||0) - Number(a.toneladas_mes||0); });
  else if(sortBy === 'toneladas_asc') sorted.sort(function(a,b){ return Number(a.toneladas_mes||0) - Number(b.toneladas_mes||0); });
  else if(sortBy === 'pago_desc') sorted.sort(function(a,b){ return Number(b.pago_mes||0) - Number(a.pago_mes||0); });
  else if(sortBy === 'pago_asc') sorted.sort(function(a,b){ return Number(a.pago_mes||0) - Number(b.pago_mes||0); });
  else sorted.sort(function(a,b){ return (a.nombre_completo||'').localeCompare(b.nombre_completo||''); });
  return sorted;
}
