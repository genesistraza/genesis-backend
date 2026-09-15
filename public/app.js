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

// Redirige a index.html si no hay sesión, o si el rol no está permitido en esta página.
function gtRequireAuth(allowedRoles){
  var token = gtGetToken();
  var role = gtGetRole();
  if(!token || (allowedRoles && allowedRoles.indexOf(role) === -1)){
    window.location.href = 'index.html';
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
  var d = new Date(value);
  return d.toLocaleDateString('es-CO', { year: 'numeric', month: 'short', day: 'numeric' });
}
