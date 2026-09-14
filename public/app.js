// Genesis Traza - helpers compartidos para dashboard.html y admin.html
var API_BASE = 'https://genesis-backend-production-edc7.up.railway.app';

function gtGetToken(){ return localStorage.getItem('gt_token'); }
function gtGetRole(){ return localStorage.getItem('gt_role'); }
function gtGetFullName(){ return localStorage.getItem('gt_fullName'); }

function gtLogout(){
  localStorage.removeItem('gt_token');
  localStorage.removeItem('gt_role');
  localStorage.removeItem('gt_fullName');
  window.location.href = 'index.html';
}

// Redirige a index.html si no hay sesión, o si el rol no está permitido en esta página.
function gtRequireAuth(allowedRoles){
  var token = gtGetToken();
  var role = gtGetRole();
  if(!token || (allowedRoles && allowedRoles.indexOf(role) === -1)){
    window.location.href = 'index.html';
    return null;
  }
  return { token: token, role: role, fullName: gtGetFullName() };
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
        if(r.status === 401){ gtLogout(); }
        return { ok: r.ok, status: r.status, data: data };
      });
    });
}

function gtFormatCOP(value){
  return '$' + Number(value || 0).toLocaleString('es-CO');
}

function gtFormatDate(value){
  if(!value) return '—';
  var d = new Date(value);
  return d.toLocaleDateString('es-CO', { year: 'numeric', month: 'short', day: 'numeric' });
}
