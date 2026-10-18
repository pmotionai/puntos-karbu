// Servidor de les targetes de punts de Gelats Karbu (sírvelo): tres targetes (cafès, bubble tea i gelats).
// - Clientes reales: cada uno se registra una vez (nombre, teléfono, privacidad y, si quiere, ofertas) y su móvil guarda su identificador.
//   Al escanear el QR del mostrador la tarjeta ya sabe quién es y pide el sello sola.
// - Panel del negocio protegido con PIN (NEGOCIO_PIN, por defecto 2580 en la demo).
// - Avisos push (Web Push con VAPID, sin librerías): el push va vacío y el service worker pide el texto a /api/pushmsg.
// - Demo: los datos viven en memoria. Si el servidor gratuito se duerme, cada móvil vuelve a subir su copia al abrirse.
//   En la versión real van a una base de datos (Supabase / Postgres en la UE).
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 10003;
const CARDS = { cafe:{ n:10, icon:"☕", nom:"cafè", premi:"un cafè" }, bubble:{ n:6, icon:"🧋", nom:"bubble tea", premi:"un bubble tea" }, gelat:{ n:8, icon:"🍦", nom:"gelat", premi:"una terrina petita" } };
const TYPES_OK = t => CARDS[t] ? t : "cafe";
const zero = () => ({ cafe:0, bubble:0, gelat:0 });
const PUB = path.join(__dirname, "public");
const PIN = process.env.NEGOCIO_PIN || "2580";
const BUILD = process.env.RENDER_GIT_COMMIT || String(fs.statSync(path.join(PUB, "index.html")).mtimeMs);

/* ---------- datos ---------- */
let DB = { gen: Date.now().toString(36), clients: {}, reqs: [], nextCard: 1 };
const killed = new Set();     // generaciones borradas con «Reiniciar la demo»: esas copias no se recuperan
let ver = 0; const bump = () => { ver++; };
const now = () => Date.now();
const rid = n => crypto.randomBytes(n).toString("base64url");
const telNorm = t => String(t || "").replace(/[^\d]/g, "").replace(/^34(?=\d{9}$)/, "");
const safe = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);
const pub = c => c && { id:c.id, name:c.name, tel:c.tel, card:c.card, ofertas:c.ofertas, privAt:c.privAt, stamps:c.stamps, free:c.free, st:c.st, fr:c.fr, visits:c.visits, last:c.last, canal:c.canal, avisos:c.avisos.slice(-5) };
const byTel = t => Object.values(DB.clients).find(c => c.tel && c.tel === telNorm(t));
function newClient(o){
  const c = { id:rid(12), name:safe(o.name, 40), tel:telNorm(o.tel).slice(0, 15), card:String(DB.nextCard++).padStart(4, "0"),
    ofertas:!!o.ofertas, privAt:new Date().toISOString(), canal:o.canal || "app", stamps:0, free:0, st:zero(), fr:zero(), visits:0, last:0, avisos:[] };
  DB.clients[c.id] = c; bump(); return c;
}
function addAviso(c, m){ c.avisos.push({ id:now() + "" + Math.random().toString(36).slice(2,6), m, at:now() }); c.avisos = c.avisos.slice(-8); }
function addStamp(c, type){
  const t = TYPES_OK(type), K = CARDS[t];
  c.st = c.st || zero(); c.fr = c.fr || zero();
  c.st[t]++; c.stamps++; const full = c.st[t] % K.n === 0; if (full){ c.fr[t]++; c.free++; } c.visits++; c.last = now();
  const m = full ? `🎉 Targeta de ${K.nom} completa! Et convidem a ${K.premi}.` : `${K.icon} +1 segell de ${K.nom}. Te'n falten ${K.n - c.st[t] % K.n} per ${K.premi} de franc.`;
  addAviso(c, m); bump(); notifyClient(c.id, { title:"Gelats Karbu", body:m, url:"/#cliente", ask:true });
}
function redeem(c, type){
  const t = TYPES_OK(type); c.fr = c.fr || zero();
  if (!(c.fr[t] > 0)) return false;
  c.fr[t]--; c.free = Math.max(0, c.free - 1);
  const m = `🎁 Que vagi de gust el teu ${CARDS[t].nom} de franc!`;
  addAviso(c, m); bump(); notifyClient(c.id, { title:"Gelats Karbu", body:m, url:"/#cliente" }); return true;
}

/* ---------- Web Push ---------- */
const VPUB = process.env.VAPID_PUBLIC || "", VPRIV = process.env.VAPID_PRIVATE || "";
let vKey = null;
if (VPUB && VPRIV){
  const raw = Buffer.from(VPUB, "base64url");
  vKey = crypto.createPrivateKey({ format:"jwk", key:{ kty:"EC", crv:"P-256", d:VPRIV,
    x:raw.subarray(1, 33).toString("base64url"), y:raw.subarray(33, 65).toString("base64url") } });
}
const subs = new Map();   // endpoint → { sub, role, cid, reviewed, msg }
function vapidJWT(aud){
  const h = Buffer.from(JSON.stringify({ typ:"JWT", alg:"ES256" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ aud, exp:Math.floor(now()/1000) + 12*3600, sub:"mailto:contacto@pmotionia.com" })).toString("base64url");
  const sig = crypto.sign("sha256", Buffer.from(h + "." + p), { key:vKey, dsaEncoding:"ieee-p1363" }).toString("base64url");
  return `${h}.${p}.${sig}`;
}
function push(endpoint){
  if (!vKey) return;
  const u = new URL(endpoint);
  const req = https.request(u, { method:"POST", headers:{ TTL:"3600", Urgency:"high", "Content-Length":0,
    Authorization:`vapid t=${vapidJWT(u.origin)}, k=${VPUB}` } }, res => {
    console.log("push", u.host, res.statusCode);
    if (res.statusCode === 404 || res.statusCode === 410) subs.delete(endpoint);
    res.resume();
  });
  req.on("error", e => console.log("push error", u.host, e.message)); req.end();
}
function deliver(ep, s, msg){
  s.msg = (msg.ask && !s.reviewed) ? { title:msg.title, body:msg.body + " T'ha agradat? Toca i deixa'ns una ressenya ⭐", url:"/?resena=1#cliente" } : msg;
  push(ep);
}
function notifyClient(cid, msg){ for (const [ep, s] of subs) if (s.role === "cliente" && s.cid === cid) deliver(ep, s, msg); }
function notifyNegocio(msg){ for (const [ep, s] of subs) if (s.role === "negocio") deliver(ep, s, msg); }

/* ---------- HTTP ---------- */
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req, cb) => { let b = ""; req.on("data", c => { b += c; if (b.length > 2e5) req.destroy(); }); req.on("end", () => { try { cb(JSON.parse(b || "{}")); } catch (e) { cb(null); } }); };
const DAY = 864e5;

function panel(){
  const cs = Object.values(DB.clients);
  const mes = cs.reduce((a, c) => a + (c.last > now() - 30*DAY ? c.visits : 0), 0);
  const rep = cs.length ? Math.round(100 * cs.filter(c => c.visits >= 2).length / cs.length) : 0;
  return { ver, gen:DB.gen,
    reqs: DB.reqs.filter(r => r.status === "pendiente").map(r => { const c = DB.clients[r.cid] || {}; return { ...r, name:c.name || "Client", have:(c.st || zero())[r.type] || 0, free:(c.fr || zero())[r.type] || 0 }; }),
    clients: cs.sort((a, b) => (b.last || 0) - (a.last || 0)).map(pub),
    stats: { clientes:cs.length, visitasMes:mes, repiten:rep, conOfertas:cs.filter(c => c.ofertas).length } };
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x"), P = url.pathname, POST = req.method === "POST";
  if (P === "/api/version") return send(res, 200, BUILD, "text/plain");
  if (P === "/api/vapid") return vKey ? send(res, 200, VPUB, "text/plain") : send(res, 503, "sin claves", "text/plain");

  /* --- cliente --- */
  if (P === "/api/register" && POST) return readBody(req, b => {
    if (!b || !safe(b.name, 40) || telNorm(b.tel).length < 9) return send(res, 400, { error:"Falten el nom o un telèfon vàlid" });
    if (!b.priv) return send(res, 400, { error:"Cal acceptar la política de privacitat" });
    if (byTel(b.tel)) return send(res, 409, { error:"Ja hi ha una targeta amb aquest telèfon", exists:true });
    const c = newClient({ name:b.name, tel:b.tel, ofertas:b.ofertas, canal:"app" });
    addAviso(c, "Benvingut/da a Gelats Karbu! Tens tres targetes: cafès, bubble tea i gelats. Cada compra suma un segell 🍦");
    console.log("registro", c.card); send(res, 200, { gen:DB.gen, client:pub(c) });
  });
  if (P === "/api/login" && POST) return readBody(req, b => {
    const c = b && byTel(b.tel);          // demo: sin código por SMS (en la versión real, código de un solo uso)
    return c ? send(res, 200, { gen:DB.gen, client:pub(c) }) : send(res, 404, { error:"No hi ha cap targeta amb aquest telèfon" });
  });
  if (P === "/api/me" && POST) return readBody(req, b => {
    if (!b || !b.id) return send(res, 400, { error:"id" });
    let c = DB.clients[b.id];
    if (!c && b.copy && (b.gen === DB.gen || killed.has(b.gen))) return send(res, 410, { error:"reset" });     // se dio de baja o se reinició la demo
    if (!c && b.copy && b.copy.id === b.id && !byTel(b.copy.tel)){                       // el servidor se ha reiniciado: el móvil devuelve su copia
      c = { ...b.copy, tel:telNorm(b.copy.tel), st:{ ...zero(), ...(b.copy.st || {}) }, fr:{ ...zero(), ...(b.copy.fr || {}) }, avisos:(b.copy.avisos || []).slice(-8), privAt:b.copy.privAt || new Date().toISOString() };
      DB.clients[c.id] = c; DB.nextCard = Math.max(DB.nextCard, (+c.card || 0) + 1); bump();
    }
    if (!c) return send(res, 410, { error:"No trobem la teva targeta" });
    const r = DB.reqs.filter(x => x.cid === c.id).slice(-1)[0];
    send(res, 200, { gen:DB.gen, ver, client:pub(c), req:r ? { id:r.id, status:r.status, at:r.at, type:r.type, kind:r.kind || "segell" } : null });
  });
  // Sello o premio: el cliente lo pide desde su móvil y la barra lo acepta. El premio solo se descuenta al aceptarlo,
  // así no se puede enseñar la misma pantalla dos veces.
  if (P === "/api/request" && POST) return readBody(req, b => {
    const c = b && DB.clients[b.id];
    if (!c) return send(res, 410, { error:"No trobem la teva targeta" });
    const t = TYPES_OK(b.type), kind = b.kind === "premi" ? "premi" : "segell";
    if (kind === "premi" && !((c.fr || zero())[t] > 0)) return send(res, 400, { error:"No tens cap premi d'aquesta targeta" });
    let r = DB.reqs.find(x => x.cid === c.id && x.status === "pendiente"), avisar = !r;
    if (r && (r.type !== t || (r.kind || "segell") !== kind)){ r.type = t; r.kind = kind; r.at = now(); bump(); avisar = true; }
    if (!r){ r = { id:rid(6), cid:c.id, type:t, kind, at:now(), status:"pendiente" }; DB.reqs.push(r); DB.reqs = DB.reqs.slice(-200); bump(); }
    if (avisar) notifyNegocio(kind === "premi"
      ? { title:"Premi per entregar", body:`🎁 ${c.name} vol el seu ${CARDS[t].nom} de franc. Toca per acceptar-ho.`, url:"/#negocio" }
      : { title:"Nou segell per confirmar", body:`${CARDS[t].icon} ${c.name} demana un segell de ${CARDS[t].nom}. Toca per acceptar-lo.`, url:"/#negocio" });
    send(res, 200, { req:{ id:r.id, status:r.status, at:r.at, type:r.type, kind:r.kind || "segell" } });
  });
  if (P === "/api/delete-me" && POST) return readBody(req, b => {     // derecho de supresión
    const c = b && DB.clients[b.id];
    if (c){ delete DB.clients[c.id]; DB.reqs = DB.reqs.filter(r => r.cid !== c.id); for (const [ep, s] of subs) if (s.cid === c.id) subs.delete(ep); bump(); console.log("baja", c.card); }
    send(res, 200, { ok:true, gen:DB.gen });
  });

  /* --- negocio (PIN) --- */
  if (P.startsWith("/api/neg/")){
    if (req.headers["x-pin"] !== PIN) return send(res, 401, { error:"PIN incorrecte" });
    if (P === "/api/neg/panel") return send(res, 200, panel());
    if (!POST) return send(res, 405, { error:"method" });
    return readBody(req, b => {
      if (!b) return send(res, 400, { error:"json" });
      if (P === "/api/neg/decide"){
        const r = DB.reqs.find(x => x.id === b.id); const c = r && DB.clients[r.cid];
        if (!r || r.status !== "pendiente" || !c) return send(res, 404, { error:"Ja no està pendent" });
        const premi = r.kind === "premi";
        if (b.ok && premi && !redeem(c, r.type)){ r.status = "rechazada"; bump(); return send(res, 400, { error:"Aquest client ja no té el premi disponible" }); }
        r.status = b.ok ? "aceptada" : "rechazada"; bump();
        if (b.ok && !premi) addStamp(c, r.type);
        if (!b.ok) notifyClient(c.id, { title:"Gelats Karbu", body:premi ? "No s'ha pogut fer servir el premi. Pregunta a la barra." : "No hem pogut confirmar el segell. Pregunta a la barra.", url:"/#cliente" });
        return send(res, 200, panel());
      }
      if (P === "/api/neg/stamp"){ const c = DB.clients[b.id]; if (!c) return send(res, 404, { error:"Client no trobat" }); addStamp(c, b.type); return send(res, 200, panel()); }
      if (P === "/api/neg/redeem"){ const c = DB.clients[b.id]; if (!c) return send(res, 404, { error:"Client no trobat" }); if (!redeem(c, b.type)) return send(res, 400, { error:"No té cap premi d'aquesta targeta" }); return send(res, 200, panel()); }
      if (P === "/api/neg/newclient"){
        if (!safe(b.name, 40)) return send(res, 400, { error:"Falta el nom" });
        if (b.tel && byTel(b.tel)) return send(res, 409, { error:"Ja hi ha un client amb aquest telèfon" });
        const c = newClient({ name:b.name, tel:b.tel, ofertas:b.ofertas, canal:"mostrador" });
        if (b.first) addStamp(c, b.type);
        return send(res, 200, { ...panel(), created:pub(c) });
      }
      if (P === "/api/neg/broadcast"){
        const m = safe(b.m, 200); if (!m) return send(res, 400, { error:"Escriu l'avís" });
        let cs = Object.values(DB.clients).filter(c => c.ofertas);                       // solo a quien aceptó recibir ofertas
        if (b.seg === "dormidos") cs = cs.filter(c => !c.last || c.last < now() - 30*DAY);
        if (b.seg === "top") cs = cs.sort((a, z) => z.visits - a.visits).slice(0, 10);
        cs.forEach(c => { addAviso(c, m); notifyClient(c.id, { title:"Novetat de Gelats Karbu", body:m, url:"/#cliente" }); }); bump();
        return send(res, 200, { ...panel(), sent:cs.length });
      }
      if (P === "/api/neg/reset"){ killed.add(DB.gen); DB = { gen:Date.now().toString(36), clients:{}, reqs:[], nextCard:1 }; for (const [ep, s] of subs) if (s.role === "cliente") subs.delete(ep); bump(); return send(res, 200, panel()); }
      send(res, 404, { error:"no" });
    });
  }

  /* --- push --- */
  if (P === "/api/subscribe" && POST) return readBody(req, b => {
    if (!b || !b.sub || !b.sub.endpoint || !/^https:\/\//.test(b.sub.endpoint)) return send(res, 400, { error:"sub" });
    const role = b.role === "negocio" ? "negocio" : "cliente";
    if (role === "negocio" && b.pin !== PIN) return send(res, 401, { error:"PIN" });
    const old = subs.get(b.sub.endpoint);
    const s = { sub:b.sub, role, cid:role === "cliente" ? b.cid : null, reviewed:!!b.reviewed, msg:old ? old.msg : null };
    subs.set(b.sub.endpoint, s);
    console.log("subscribe", role, new URL(b.sub.endpoint).host, "total", subs.size);
    if (b.test){ s.msg = { title:"Avisos activats", body:role === "negocio" ? "T'avisarem de cada segell per confirmar 🍦" : "T'avisarem dels teus segells i ofertes 🍦", url:role === "negocio" ? "/#negocio" : "/#cliente" }; push(b.sub.endpoint); }
    send(res, 200, { ok:true });
  });
  if (P === "/api/pushmsg" && POST) return readBody(req, b => {
    const s = b && subs.get(b.endpoint);
    const m = (s && s.msg) || { title:"Gelats Karbu", body:"Tens novetats a la teva targeta 🍦", url:"/#cliente" };
    if (s) s.msg = null;
    send(res, 200, m);
  });

  /* --- archivos --- */
  const file = path.join(PUB, P === "/" ? "index.html" : path.normalize(decodeURIComponent(P)));
  if (!file.startsWith(PUB)) return send(res, 403, "no", "text/plain");
  const TYPES = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".webmanifest":"application/manifest+json", ".png":"image/png" };
  fs.readFile(file, (e, d) => e ? send(res, 404, "No trobat", "text/plain") : send(res, 200, d, TYPES[path.extname(file)] || "application/octet-stream"));
}).listen(PORT, () => console.log("Punts Gelats Karbu a :" + PORT + (vKey ? " · push activado" : " · push sin claves")));
