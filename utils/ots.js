// Cliente minimo de OpenTimestamps (https://opentimestamps.org): ancla una huella en Bitcoin a
// traves de los calendarios publicos y gratuitos, y luego "actualiza" la prueba cuando Bitcoin la
// confirma (unas horas despues). Genera archivos .ots estandar, verificables por cualquiera en
// opentimestamps.org o con el cliente oficial 'ots', sin depender de Genesis Traza.
const crypto = require('crypto');

const CALENDARIOS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
];
const MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
const TAG_PENDIENTE = '83dfe30d2ef90c8e';
const TAG_BITCOIN = '0588960d73d71901';
const OP_SHA256 = 0x08, OP_APPEND = 0xf0, OP_PREPEND = 0xf1;
const UNARIAS = { 0x08: 'sha256', 0x02: 'sha1', 0x03: 'ripemd160', 0x67: 'keccak256', 0xf2: 'reverse', 0xf3: 'hexlify' };
const HEADERS = { Accept: 'application/vnd.opentimestamps.v1', 'User-Agent': 'genesis-traza' };

// ---------- serializacion ----------
function varuint(n) { const b = []; do { let x = n & 0x7f; n = Math.floor(n / 128); if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); }
const varbytes = (buf) => Buffer.concat([varuint(buf.length), buf]);
class Lector {
  constructor(buf) { this.b = buf; this.i = 0; }
  byte() { if (this.i >= this.b.length) throw new Error('OTS truncado'); return this.b[this.i++]; }
  bytes(n) { if (this.i + n > this.b.length) throw new Error('OTS truncado'); const r = this.b.subarray(this.i, this.i + n); this.i += n; return Buffer.from(r); }
  varuint() { let v = 0, m = 1, x; do { x = this.byte(); v += (x & 0x7f) * m; m *= 128; } while (x & 0x80); return v; }
  varbytes() { return this.bytes(this.varuint()); }
}

function aplicar(tag, arg, msg) {
  switch (tag) {
    case OP_APPEND: return Buffer.concat([msg, arg]);
    case OP_PREPEND: return Buffer.concat([arg, msg]);
    case 0xf2: return Buffer.from(msg).reverse();
    case 0xf3: return Buffer.from(msg.toString('hex'));
    case 0x67: throw new Error('keccak256 no soportado');
    default: return crypto.createHash(UNARIAS[tag]).update(msg).digest();
  }
}

// Nodo: { msg, atts: [{tag, payload}], ops: [{tag, arg, hijo}] }
function leerTimestamp(lec, msg) {
  const nodo = { msg, atts: [], ops: [] };
  const item = (tag) => {
    if (tag === 0x00) { nodo.atts.push({ tag: lec.bytes(8).toString('hex'), payload: lec.varbytes() }); return; }
    const arg = (tag === OP_APPEND || tag === OP_PREPEND) ? lec.varbytes() : null;
    if (arg === null && !(tag in UNARIAS)) throw new Error('Operacion OTS desconocida: ' + tag);
    nodo.ops.push({ tag, arg, hijo: leerTimestamp(lec, aplicar(tag, arg, msg)) });
  };
  let tag = lec.byte();
  while (tag === 0xff) { item(lec.byte()); tag = lec.byte(); }
  item(tag);
  return nodo;
}
function escribirTimestamp(nodo) {
  const items = [
    ...nodo.atts.map((a) => Buffer.concat([Buffer.from([0x00]), Buffer.from(a.tag, 'hex'), varbytes(a.payload)])),
    ...nodo.ops.map((o) => Buffer.concat([Buffer.from([o.tag]), o.arg ? varbytes(o.arg) : Buffer.alloc(0), escribirTimestamp(o.hijo)])),
  ];
  return Buffer.concat(items.map((it, i) => (i < items.length - 1 ? Buffer.concat([Buffer.from([0xff]), it]) : it)));
}
function leerArchivo(buf) {
  const lec = new Lector(buf);
  if (!lec.bytes(MAGIC.length).equals(MAGIC)) throw new Error('No es un archivo .ots');
  if (lec.varuint() !== 1) throw new Error('Version .ots no soportada');
  if (lec.byte() !== OP_SHA256) throw new Error('Solo se soporta sha256');
  const digest = lec.bytes(32);
  return { digest, raiz: leerTimestamp(lec, digest) };
}
const escribirArchivo = (digest, raiz) => Buffer.concat([MAGIC, varuint(1), Buffer.from([OP_SHA256]), digest, escribirTimestamp(raiz)]);

// ---------- red ----------
async function pedir(url, opts = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try { return await fetch(url, { ...opts, headers: HEADERS, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

// Sella un digest (Buffer de 32 bytes). Agrega un nonce aleatorio (como el cliente oficial) para
// que los calendarios no vean la huella real. Devuelve el .ots pendiente (Buffer).
async function sellarDigest(digest) {
  const nonce = crypto.randomBytes(16);
  const conNonce = Buffer.concat([digest, nonce]);
  const enviado = crypto.createHash('sha256').update(conNonce).digest();
  const nodoEnviado = { msg: enviado, atts: [], ops: [] };
  const errores = [];
  for (const cal of CALENDARIOS) {
    try {
      const r = await pedir(cal + '/digest', { method: 'POST', body: enviado });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const sub = leerTimestamp(new Lector(Buffer.from(await r.arrayBuffer())), enviado);
      nodoEnviado.atts.push(...sub.atts); nodoEnviado.ops.push(...sub.ops);
    } catch (e) { errores.push(cal + ': ' + e.message); }
  }
  if (!nodoEnviado.atts.length && !nodoEnviado.ops.length) throw new Error('Ningun calendario respondio. ' + errores.join(' | '));
  const raiz = { msg: digest, atts: [], ops: [{ tag: OP_APPEND, arg: nonce, hijo: { msg: conNonce, atts: [], ops: [{ tag: OP_SHA256, arg: null, hijo: nodoEnviado }] } }] };
  return escribirArchivo(digest, raiz);
}

// Recorre el arbol y reemplaza cada atestacion pendiente por la respuesta definitiva del calendario.
async function actualizar(otsBuf) {
  const { digest, raiz } = leerArchivo(otsBuf);
  let cambio = false;
  async function visitar(nodo) {
    const quedan = [];
    for (const a of nodo.atts) {
      if (a.tag !== TAG_PENDIENTE) { quedan.push(a); continue; }
      const uri = new Lector(a.payload).varbytes().toString('utf8');
      if (!/^https:\/\/[a-z0-9.-]+$/i.test(uri)) { quedan.push(a); continue; }
      try {
        const r = await pedir(uri + '/timestamp/' + nodo.msg.toString('hex'));
        if (r.ok) {
          const sub = leerTimestamp(new Lector(Buffer.from(await r.arrayBuffer())), nodo.msg);
          nodo.ops.push(...sub.ops); quedan.push(...sub.atts); cambio = true; continue;
        }
      } catch (e) { /* calendario caido: se reintenta en la siguiente pasada */ }
      quedan.push(a);
    }
    nodo.atts = quedan;
    for (const o of nodo.ops) await visitar(o.hijo);
  }
  await visitar(raiz);
  return { ots: escribirArchivo(digest, raiz), cambio, ...estado(raiz) };
}

// Resumen: si ya hay atestacion en Bitcoin y en que bloque.
function estado(raiz) {
  let bloque = null, pendientes = 0;
  (function visitar(n) {
    for (const a of n.atts) {
      if (a.tag === TAG_BITCOIN) { const h = new Lector(a.payload).varuint(); bloque = bloque === null ? h : Math.min(bloque, h); }
      if (a.tag === TAG_PENDIENTE) pendientes++;
    }
    n.ops.forEach((o) => visitar(o.hijo));
  })(raiz);
  return { confirmado: bloque !== null, bloque, pendientes };
}
const info = (otsBuf) => { const { digest, raiz } = leerArchivo(otsBuf); return { digest: digest.toString('hex'), ...estado(raiz) }; };

module.exports = { sellarDigest, actualizar, info, leerArchivo, escribirArchivo };
