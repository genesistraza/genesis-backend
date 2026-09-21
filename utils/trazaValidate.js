// Validacion central del motor generico de Pruebas (tz_*): tipos, rangos, fechas, listas fijas,
// formatos, coherencia entre campos, pertenencia al mismo centro y unicidad. Antes el motor
// aceptaba cualquier cosa y dejaba que la base de datos fallara con un error 500.
const pool = require('../db/pool');

// ---- Fechas (siempre como texto 'YYYY-MM-DD', dia de calendario de Colombia) ----
function todayCO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}
function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function addYears(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${String(y + n).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---- Reglas por nombre de campo ----
const NEGATIVE_OK = new Set(['longitud', 'latitud']);
const RANGES = {
  fase: [1, 8], anio: [2000, 2100], frecuencia_semanal: [1, 7], secuencia_orden: [0, 9999],
  latitud: [-5, 14], longitud: [-82, -66]
};
const MAX_DECIMAL = 99999999; // numeric(12,4) admite hasta ~1e8
// Fechas que registran algo que ya ocurrio: no pueden estar en el futuro.
const NO_FUTURE = new Set(['fecha', 'fecha_factura', 'fecha_completada', 'fecha_respuesta', 'fecha_exp_documento',
  'fecha_nacimiento', 'fecha_estado', 'fecha_actualizacion']);
const PATTERNS = {
  telefono: [/^[0-9+()\-\s]{7,20}$/, 'debe ser un teléfono válido (solo números, espacios, + - ( )).'],
  correo: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'debe ser un correo válido.'],
  cod_departamento_dane: [/^\d{2}$/, 'debe tener exactamente 2 dígitos (código DANE).'],
  cod_municipio_dane: [/^\d{3}$/, 'debe tener exactamente 3 dígitos (código DANE).'],
  hora_inicio: [/^([01]\d|2[0-3]):[0-5]\d$/, 'debe tener formato HH:MM (24 horas).'],
  hora_finalizacion: [/^([01]\d|2[0-3]):[0-5]\d$/, 'debe tener formato HH:MM (24 horas).'],
  digito_verificacion: [/^\d$/, 'debe ser un solo dígito.'],
  placa: [/^[A-Za-z0-9 \-]{1,20}$/, 'solo puede tener letras, números, espacios o guion.'],
  codigo_cufe: [/^[A-Fa-f0-9]{96}$/, 'debe ser el CUFE de 96 caracteres hexadecimales.']
};

function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// ---- Largo maximo real de cada columna (de information_schema, una sola vez) ----
let maxLenPromise = null;
function loadMaxLens() {
  if (!maxLenPromise) {
    maxLenPromise = pool.query(
      `SELECT table_name, column_name, character_maximum_length AS l FROM information_schema.columns
       WHERE table_name LIKE 'tz\\_%' AND data_type = 'character varying' AND character_maximum_length IS NOT NULL`
    ).then((r) => {
      const map = new Map();
      r.rows.forEach((x) => map.set(x.table_name + '.' + x.column_name, x.l));
      return map;
    }).catch((e) => { maxLenPromise = null; throw e; });
  }
  return maxLenPromise;
}

function fail(f, msg) { return { error: `"${f.label}": ${msg}` }; }

// Limpia y valida UN campo. Devuelve {value} o {error}.
function cleanField(entity, f, raw, maxLens) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { value: null };

  switch (f.type) {
    case 'text': {
      let s = String(raw).trim();
      if (f.name === 'nro_documento') s = s.replace(/[.\s,]/g, '');
      if (f.name === 'nit') s = s.replace(/[.\s]/g, '');
      if (f.name === 'placa') s = s.toUpperCase();
      const max = maxLens.get(entity.table + '.' + f.name) || 2000;
      if (s.length > max) return fail(f, `es muy largo (máximo ${max} caracteres).`);
      const p = PATTERNS[f.name];
      if (p && !p[0].test(s)) return fail(f, p[1]);
      if (f.name === 'nro_documento' && !/^[A-Za-z0-9]{4,20}$/.test(s)) return fail(f, 'debe tener entre 4 y 20 letras o números.');
      if (f.name === 'nit' && !/^\d{6,10}(-\d)?$/.test(s)) return fail(f, 'debe ser un NIT válido (ej. 901494752-8).');
      return { value: s };
    }
    case 'number':
    case 'decimal': {
      if (typeof raw === 'boolean' || (typeof raw === 'string' && !/^-?\d+([.,]\d+)?$/.test(raw.trim()))) return fail(f, 'debe ser un número.');
      const n = Number(typeof raw === 'string' ? raw.trim().replace(',', '.') : raw);
      if (!Number.isFinite(n)) return fail(f, 'debe ser un número.');
      if (f.type === 'number' && !Number.isInteger(n)) return fail(f, 'debe ser un número entero.');
      if (n < 0 && !NEGATIVE_OK.has(f.name)) return fail(f, 'no puede ser negativo.');
      if (Math.abs(n) > MAX_DECIMAL) return fail(f, 'es demasiado grande.');
      const r = RANGES[f.name];
      if (r && (n < r[0] || n > r[1])) return fail(f, `debe estar entre ${r[0]} y ${r[1]}.`);
      return { value: n };
    }
    case 'date': {
      const s = String(raw).slice(0, 10);
      if (!isValidYmd(s)) return fail(f, 'no es una fecha válida (usa AAAA-MM-DD).');
      if (s < '1900-01-01' || s > '2100-12-31') return fail(f, 'está fuera de un rango razonable.');
      if (f.name === 'fecha' && s < '2000-01-01') return fail(f, 'es demasiado antigua.');
      if (NO_FUTURE.has(f.name) && s > todayCO()) return fail(f, 'no puede ser una fecha futura.');
      return { value: s };
    }
    case 'select-entity':
    case 'select-catalogo': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) return fail(f, 'selecciona una opción válida.');
      return { value: n };
    }
    case 'select-fixed': {
      const key = stripAccents(raw);
      const opt = (f.options || []).find((o) => stripAccents(o.value) === key || stripAccents(o.label) === key);
      if (!opt) return fail(f, 'valor no permitido. Opciones: ' + (f.options || []).map((o) => o.label).join(', ') + '.');
      return { value: opt.value };
    }
    default:
      return { value: raw };
  }
}

// ---- Coherencia entre campos de una misma fila ----
const CROSS = {
  balance_masas(m, errors) {
    const cant = Number(m.cantidad || 0);
    const rech = Number(m.cantidad_rechazo || 0);
    const nosui = Number(m.cantidad_nosui || 0);
    if (!(cant > 0)) errors.push('La cantidad de material debe ser mayor que 0.');
    if (rech > cant) errors.push(`El rechazo (${rech} kg) no puede ser mayor que la cantidad de material (${cant} kg).`);
    if (nosui > cant) errors.push(`La cantidad no SUI (${nosui} kg) no puede ser mayor que la cantidad de material (${cant} kg).`);
  },
  ventas(m, errors) {
    if (m.kg != null && m.toneladas != null && Math.abs(Number(m.kg) / 1000 - Number(m.toneladas)) > 0.0015) {
      errors.push('Los kilogramos y las toneladas no coinciden (toneladas = kg / 1000).');
    }
    if (m.valor_sin_iva != null && m.iva != null && m.valor_con_iva != null &&
      Math.abs(Number(m.valor_sin_iva) + Number(m.iva) - Number(m.valor_con_iva)) > 1) {
      errors.push('Subtotal sin IVA + IVA no es igual al total con IVA.');
    }
  },
  recicladores(m, errors) {
    if (m.fecha_nacimiento && m.fecha_nacimiento > addYears(todayCO(), -14)) errors.push('El reciclador debe tener al menos 14 años.');
    if (m.fecha_nacimiento && m.fecha_exp_documento && m.fecha_exp_documento <= m.fecha_nacimiento) {
      errors.push('La fecha de expedición del documento debe ser posterior a la fecha de nacimiento.');
    }
  },
  pqr(m, errors) {
    if (m.fecha && m.fecha_respuesta && m.fecha_respuesta < m.fecha) errors.push('La fecha de respuesta no puede ser anterior a la fecha de la PQR.');
    if (m.estado === 'Cerrada' && (!m.fecha_respuesta || !m.respuesta)) errors.push('Una PQR cerrada necesita fecha de respuesta y la respuesta.');
  },
  formalizacion_fases(m, errors) {
    if (m.estado === 'Completada' && !m.fecha_completada) errors.push('Una fase completada necesita su fecha de finalización.');
  },
  microrrutas_detalle(m, errors) {
    if (m.hora_inicio && m.hora_finalizacion && m.hora_finalizacion <= m.hora_inicio) errors.push('La hora de fin debe ser posterior a la de inicio.');
  }
};

// Unicidad por centro (sin distinguir mayusculas). El campo id_centro siempre va primero.
const UNIQUE_RULES = {
  recicladores: { cols: ['id_centro', 'nro_documento'], msg: 'Ya existe un reciclador con ese documento en este centro.' },
  bodegas: { cols: ['id_centro', 'cod_bodega'], msg: 'Ya existe una bodega/ECA con ese código en este centro.' },
  macrorrutas: { cols: ['id_centro', 'cod_macrorruta'], msg: 'Ya existe una macrorruta con ese código en este centro.' },
  numacros: { cols: ['id_centro', 'cod_numacro'], msg: 'Ya existe una zona con ese código en este centro.' },
  usuarios: { cols: ['id_centro', 'nuis_nuid'], msg: 'Ya existe un usuario con ese NUIS/NUID en este centro.' },
  areas_prestacion: { cols: ['id_centro', 'nombre_area'], msg: 'Ya existe un área de prestación con ese nombre en este centro.' }
};

// ---- Pertenencia al mismo centro / existencia de lo referenciado ----
async function refInfo(ctx, entities, refKey, id) {
  const ref = entities[refKey];
  const hasCentro = ref.fields.some((f) => f.name === 'id_centro');
  const cacheKey = refKey + ':' + id;
  if (ctx.refCache.has(cacheKey)) return ctx.refCache.get(cacheKey);
  let info = null;
  if (ctx.bulk) {
    if (!ctx.refTables[refKey]) {
      const r = await pool.query(`SELECT id${hasCentro ? ', id_centro' : ''} FROM ${ref.table}`);
      ctx.refTables[refKey] = new Map(r.rows.map((x) => [x.id, x]));
    }
    info = ctx.refTables[refKey].get(id) || null;
  } else {
    const r = await pool.query(`SELECT id${hasCentro ? ', id_centro' : ''} FROM ${ref.table} WHERE id = $1`, [id]);
    info = r.rows[0] || null;
  }
  ctx.refCache.set(cacheKey, info);
  return info;
}

async function catalogCategory(ctx, id) {
  if (ctx.catMap) return ctx.catMap.get(id);
  if (ctx.bulk) {
    const r = await pool.query('SELECT id, categoria FROM tz_catalogos');
    ctx.catMap = new Map(r.rows.map((x) => [x.id, x.categoria]));
    return ctx.catMap.get(id);
  }
  const r = await pool.query('SELECT categoria FROM tz_catalogos WHERE id = $1', [id]);
  return r.rows[0] ? r.rows[0].categoria : undefined;
}

function newContext(bulk) {
  return { bulk: !!bulk, refCache: new Map(), refTables: {}, catMap: null, uniqueSeen: new Map(), uniqueLoaded: {} };
}

// Valida un registro completo. input = lo que llego (parcial en PUT); existing = fila actual (PUT).
async function validateRecord(entities, entityKey, input, { existing = null, id = null, ctx = newContext(false) } = {}) {
  const entity = entities[entityKey];
  const maxLens = await loadMaxLens();
  const errors = [];
  const clean = {};

  for (const f of entity.fields) {
    if (!(f.name in input)) continue;
    const r = cleanField(entity, f, input[f.name], maxLens);
    if (r.error) errors.push(r.error); else clean[f.name] = r.value;
  }

  const merged = Object.assign({}, existing || {}, clean);
  for (const f of entity.fields) {
    if (f.required && (merged[f.name] === null || merged[f.name] === undefined || merged[f.name] === '')) {
      errors.push(`"${f.label}" es obligatorio.`);
    }
  }
  if (errors.length) return { errors, values: clean };

  // Referencias: existen, la categoria del catalogo es la correcta y son del mismo centro.
  for (const f of entity.fields) {
    const v = merged[f.name];
    if (v === null || v === undefined) continue;
    if (f.type === 'select-catalogo') {
      if (!(f.name in clean)) continue;
      const cat = await catalogCategory(ctx, v);
      if (cat !== f.categoria) errors.push(`"${f.label}": la opción elegida no es válida para este campo.`);
    } else if (f.type === 'select-entity') {
      if (!(f.name in clean) && !('id_centro' in clean)) continue;
      const info = await refInfo(ctx, entities, f.entity, v);
      if (!info) { errors.push(`"${f.label}": el registro seleccionado no existe.`); continue; }
      const entityHasCentro = entity.fields.some((x) => x.name === 'id_centro');
      if (entityHasCentro && info.id_centro !== undefined && merged.id_centro != null && info.id_centro !== Number(merged.id_centro)) {
        errors.push(`"${f.label}": pertenece a otro centro (asociación); no se pueden mezclar datos de asociaciones distintas.`);
      }
    }
  }
  if (errors.length) return { errors, values: clean };

  if (CROSS[entityKey]) CROSS[entityKey](merged, errors);

  const rule = UNIQUE_RULES[entityKey];
  if (rule && rule.cols.every((c) => merged[c] !== null && merged[c] !== undefined)) {
    const key = rule.cols.map((c) => stripAccents(merged[c])).join('|');
    if (ctx.bulk) {
      if (!ctx.uniqueLoaded[entityKey]) {
        const r = await pool.query(`SELECT ${rule.cols.join(', ')} FROM ${entity.table}`);
        ctx.uniqueLoaded[entityKey] = new Set(r.rows.filter((x) => rule.cols.every((c) => x[c] !== null)).map((x) => rule.cols.map((c) => stripAccents(x[c])).join('|')));
      }
      if (ctx.uniqueLoaded[entityKey].has(key)) errors.push(rule.msg);
      else ctx.uniqueLoaded[entityKey].add(key);
    } else {
      const where = rule.cols.map((c, i) => (i === 0 ? `${c} = $1` : `lower(trim(${c}::text)) = lower(trim($${i + 1}::text))`)).join(' AND ');
      const params = rule.cols.map((c) => merged[c]);
      let sql = `SELECT 1 FROM ${entity.table} WHERE ${where}`;
      if (id) { params.push(id); sql += ` AND id <> $${params.length}`; }
      const dup = await pool.query(sql + ' LIMIT 1', params);
      if (dup.rows.length) errors.push(rule.msg);
    }
  }
  return { errors, values: clean };
}

// Traduce errores de PostgreSQL (restricciones) a un mensaje claro y un codigo HTTP 4xx.
function mapDbError(err) {
  switch (err && err.code) {
    case '23505': return { status: 409, error: 'Ya existe un registro con esos mismos datos únicos (código, documento, etc.).' };
    case '23503': return { status: 409, error: 'No se puede completar: el registro está relacionado con otros datos (o apunta a algo que ya no existe).' };
    case '23502': return { status: 400, error: 'Falta un dato obligatorio.' };
    case '22001': return { status: 400, error: 'Algún texto es demasiado largo para su campo.' };
    case '22003': return { status: 400, error: 'Algún número es demasiado grande.' };
    case '22P02': case '22007': case '22008': return { status: 400, error: 'Algún dato tiene un formato inválido.' };
    case '23514': return { status: 400, error: 'Algún valor no cumple una regla de la base de datos.' };
    default: return null;
  }
}

module.exports = { validateRecord, cleanField, loadMaxLens, newContext, mapDbError, todayCO, isValidYmd, stripAccents, CROSS };
