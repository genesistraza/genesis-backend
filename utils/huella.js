// Huellas (hashes) para la cadena de integridad: cada registro sellado guarda la huella de su
// contenido y queda encadenado al registro anterior de su mismo centro. Cada noche las huellas del
// dia se combinan en un arbol Merkle cuya raiz se sella con OpenTimestamps (ver jobs/sellosDiarios.js).
const crypto = require('crypto');
const pool = require('../db/pool');

const CERO = '0'.repeat(64);

// Texto canonico: mismo dato => mismos bytes (claves ordenadas, sin espacios). Asi la huella no
// cambia por el orden en que PostgreSQL devuelve las claves de un JSONB.
function canonico(v) {
  if (v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canonico).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonico(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hashPar = (a, b) => sha256(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')]));

// Formato versionado de lo que entra en la huella de cada tipo de registro. Si algun dia cambia
// un formato, se crea una version nueva y las huellas viejas se siguen verificando con la suya.
const FORMATOS = {
  'comprobante-v1': (c) => ({ tipo: 'comprobante', v: 1, numero: c.numero, fecha: c.fecha, id_centro: c.id_centro, id_reciclador: c.id_reciclador, snapshot: c.snapshot }),
  'dia-v1': (d) => ({ tipo: 'dia', v: 1, id_centro: d.id_centro, fecha: d.fecha, version: d.version, datos: d.datos }),
};
const huellaDato = (version, registro) => sha256(canonico(FORMATOS[version](registro)));

// Fecha (YYYY-MM-DD) en hora de Bogota: el "dia" del sello se corta a medianoche de Colombia.
function fechaBogota(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Sella un registro dentro de la transaccion 'client' (que ya debe estar abierta). El candado por
// centro evita que dos registros simultaneos tomen la misma huella anterior.
async function sellar(client, { tipo, version, refId, idCentro, registro }) {
  await client.query('SELECT pg_advisory_xact_lock(7101, $1)', [idCentro || 0]);
  const prev = await client.query('SELECT huella FROM tz_huellas WHERE id_centro IS NOT DISTINCT FROM $1 ORDER BY id DESC LIMIT 1', [idCentro]);
  const huellaPrev = prev.rows[0] ? prev.rows[0].huella : CERO;
  const hd = huellaDato(version, registro);
  const huella = hashPar(huellaPrev, hd);
  const r = await client.query(
    `INSERT INTO tz_huellas (id_centro, tipo, ref_id, version, huella_dato, huella_prev, huella, fecha_sello)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, huella, fecha_sello`,
    [idCentro, tipo, refId, version, hd, huellaPrev, huella, fechaBogota()]
  );
  return r.rows[0];
}

// Arbol Merkle: devuelve la raiz y, para cada hoja, la lista de huellas hermanas para llegar a ella.
function merkle(hojas) {
  if (!hojas.length) return { raiz: null, pruebas: [] };
  const pruebas = hojas.map(() => []);
  let nivel = hojas.map((h, i) => ({ h, idx: [i] }));
  while (nivel.length > 1) {
    const sig = [];
    for (let i = 0; i < nivel.length; i += 2) {
      const a = nivel[i], b = nivel[i + 1];
      if (!b) { sig.push(a); continue; } // impar: sube sin pareja
      for (const k of a.idx) pruebas[k].push({ lado: 'der', h: b.h });
      for (const k of b.idx) pruebas[k].push({ lado: 'izq', h: a.h });
      sig.push({ h: hashPar(a.h, b.h), idx: a.idx.concat(b.idx) });
    }
    nivel = sig;
  }
  return { raiz: nivel[0].h, pruebas };
}
const raizDesdePrueba = (hoja, prueba) => prueba.reduce((h, p) => (p.lado === 'der' ? hashPar(h, p.h) : hashPar(p.h, h)), hoja);

// Contenido del archivo diario que se sella con OpenTimestamps (sha256 de este texto = lo anclado).
const archivoSello = (fecha, raiz, total) => canonico({ sistema: 'Genesis Traza', tipo: 'sello-diario', v: 1, fecha, raiz, registros: total });

// Verifica un registro de punta a punta: contenido, cadena y pertenencia a la raiz del dia.
async function verificar(tipo, refId, registro) {
  const h = (await pool.query('SELECT * FROM tz_huellas WHERE tipo=$1 AND ref_id=$2', [tipo, refId])).rows[0];
  if (!h) return { sellado: false };
  const res = { sellado: true, huella: h.huella, fechaSello: h.fecha_sello };
  res.integro = huellaDato(h.version, registro) === h.huella_dato;
  const sig = (await pool.query('SELECT huella_prev FROM tz_huellas WHERE id_centro IS NOT DISTINCT FROM $1 AND id > $2 ORDER BY id LIMIT 1', [h.id_centro, h.id])).rows[0];
  res.cadena = hashPar(h.huella_prev, h.huella_dato) === h.huella && (!sig || sig.huella_prev === h.huella);
  const s = (await pool.query('SELECT fecha, raiz, estado, bloque, ots IS NOT NULL AS tiene_ots FROM tz_sellos_diarios WHERE fecha=$1', [h.fecha_sello])).rows[0];
  if (s && h.prueba) {
    res.selloDia = { fecha: s.fecha, raiz: s.raiz, estado: s.estado, bloque: s.bloque, tieneOts: s.tiene_ots };
    res.enRaiz = raizDesdePrueba(h.huella, h.prueba) === s.raiz;
  }
  res.prueba = h.prueba;
  return res;
}

module.exports = { CERO, canonico, sha256, hashPar, FORMATOS, huellaDato, fechaBogota, sellar, merkle, raizDesdePrueba, archivoSello, verificar };
