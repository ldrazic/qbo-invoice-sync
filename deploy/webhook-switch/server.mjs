/**
 * Webhook switch: one fixed public URL in, a switchable destination out.
 *
 * Intuit's webhook endpoint URL is registered in the developer portal and is
 * painful to change, so it stays pointed at this VM forever. What happens
 * behind it is runtime-switchable: deliveries can go to the VM's app, to a
 * tunnel pointing at a laptop, or to both.
 *
 * Dependency-free on purpose (node: builtins only): the image is a stock
 * node:22-alpine with this directory bind-mounted, so there is no install and
 * no build step to keep in sync with the app's.
 */
import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.env.SWITCH_PORT ?? 8080);
const STATE_FILE = process.env.SWITCH_STATE_FILE ?? "/data/switch-state.json";
const PRIMARY_URL = process.env.SWITCH_APP_URL ?? "http://app:3000";
const ADMIN_TOKEN = process.env.SWITCH_ADMIN_TOKEN ?? "";

// The forward gets longer than the ack deadline so a slow-but-alive tunnel
// still receives the delivery after Intuit has already been acked.
const FORWARD_TIMEOUT_MS = Number(process.env.SWITCH_FORWARD_TIMEOUT_MS ?? 8000);
const ACK_DEADLINE_MS = Number(process.env.SWITCH_ACK_DEADLINE_MS ?? 2500);
const LOG_LIMIT = Number(process.env.SWITCH_LOG_LIMIT ?? 50);
const MAX_BODY_BYTES = Number(process.env.SWITCH_MAX_BODY_BYTES ?? 2 * 1024 * 1024);

const MODES = ["local", "forward", "both"];

// Fail closed. This service is publicly reachable and its control API can
// redirect a live QuickBooks webhook stream; running it without a token would
// let anyone do that.
if (ADMIN_TOKEN.length < 16) {
  console.error(
    "[switch] refusing to start: SWITCH_ADMIN_TOKEN must be set to a secret of at least 16 characters",
  );
  process.exit(1);
}

/** Hop-by-hop headers plus the ones we must recompute for the new connection. */
const DROP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "expect",
]);

let state = loadState();
/** @type {Array<object>} newest first */
const deliveries = [];

function loadState() {
  const fallback = {
    mode: MODES.includes(process.env.SWITCH_MODE ?? "") ? process.env.SWITCH_MODE : "local",
    target: process.env.SWITCH_TARGET_URL ?? "",
    updatedAt: null,
  };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      mode: MODES.includes(parsed.mode) ? parsed.mode : fallback.mode,
      target: typeof parsed.target === "string" ? parsed.target : fallback.target,
      updatedAt: parsed.updatedAt ?? null,
    };
  } catch {
    return fallback;
  }
}

// Atomic write: a torn state file read at boot would silently reset the mode.
function saveState() {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error(`[switch] could not persist state to ${STATE_FILE}: ${err.message}`);
  }
}

function record(entry) {
  deliveries.unshift(entry);
  if (deliveries.length > LOG_LIMIT) deliveries.length = LOG_LIMIT;
  const status = entry.status ?? `ERR ${entry.error}`;
  console.log(
    `[switch] ${entry.at} ${entry.method} ${entry.path} mode=${entry.mode} ${entry.role} -> ${entry.destination} ${status} ${entry.ms}ms`,
  );
}

function isAuthorized(req) {
  const header = req.headers["authorization"];
  const bearer = typeof header === "string" && /^Bearer /i.test(header) ? header.slice(7) : "";
  const provided = Buffer.from(bearer || asString(req.headers["x-switch-token"]) || "");
  const expected = Buffer.from(ADMIN_TOKEN);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function asString(value) {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html);
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Rebuild the outbound header set from rawHeaders so repeated headers survive.
 * The QBO `intuit-signature` HMAC covers the raw body, so the body must be
 * forwarded byte-for-byte and the signature header must ride along untouched —
 * any re-serialization downstream fails verification.
 */
function outboundHeaders(req, body, targetUrl) {
  const headers = Object.create(null);
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (DROP_HEADERS.has(name.toLowerCase())) continue;
    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
  }
  // Tunnels (ngrok et al.) route on Host, so it has to name the destination.
  headers["host"] = targetUrl.host;
  headers["content-length"] = String(body.length);
  headers["x-webhook-switch"] = "1";
  headers["x-forwarded-host"] = asString(req.headers["host"]);
  return headers;
}

function forward(base, role, req, body, mode, startedAt) {
  return new Promise((resolve) => {
    let targetUrl;
    try {
      const trimmed = base.replace(/\/+$/, "");
      targetUrl = new URL(trimmed + req.url);
    } catch {
      const entry = {
        at: startedAt,
        method: req.method,
        path: req.url,
        mode,
        role,
        destination: base,
        status: null,
        error: "invalid destination url",
        ms: 0,
      };
      record(entry);
      resolve({ ok: false, error: "invalid destination url" });
      return;
    }

    const client = targetUrl.protocol === "https:" ? https : http;
    const began = Date.now();
    const finish = (result, error, status) => {
      record({
        at: startedAt,
        method: req.method,
        path: req.url,
        mode,
        role,
        destination: targetUrl.href,
        status: status ?? null,
        error: error ?? null,
        ms: Date.now() - began,
      });
      resolve(result);
    };

    const request = client.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: outboundHeaders(req, body, targetUrl),
      },
      (upstream) => {
        upstream.resume(); // drain so the socket can be reused
        upstream.on("end", () =>
          finish({ ok: true, status: upstream.statusCode }, null, upstream.statusCode),
        );
      },
    );
    request.setTimeout(FORWARD_TIMEOUT_MS, () => request.destroy(new Error("forward timeout")));
    request.on("error", (err) => finish({ ok: false, error: err.message }, err.message));
    request.end(body);
  });
}

function destinationsFor(mode) {
  if (mode === "forward") return { primary: state.target, secondary: null };
  if (mode === "both") return { primary: PRIMARY_URL, secondary: state.target };
  return { primary: PRIMARY_URL, secondary: null };
}

async function handleWebhook(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: err.message });
    return;
  }

  const mode = state.mode;
  const startedAt = new Date().toISOString();
  const { primary, secondary } = destinationsFor(mode);

  if (!primary) {
    // "forward" with no target configured: ack anyway rather than hand Intuit
    // an error it would retry for hours.
    record({
      at: startedAt,
      method: req.method,
      path: req.url,
      mode,
      role: "primary",
      destination: "(unset)",
      status: null,
      error: "no target url configured",
      ms: 0,
    });
    sendJson(res, 202, { accepted: true, mode, note: "no target url configured" });
    return;
  }

  const primaryCall = forward(primary, "primary", req, body, mode, startedAt);
  // Fire-and-forget: a dead tunnel must never delay or fail the ack.
  if (secondary) void forward(secondary, "secondary", req, body, mode, startedAt);

  // Ack on the primary's result, but never later than the deadline: Intuit
  // times the delivery out and retry-storms, and the forward is still in
  // flight (and still logged) after we have answered.
  let ackTimer;
  const outcome = await Promise.race([
    primaryCall,
    new Promise((resolve) => {
      ackTimer = setTimeout(() => resolve({ ok: false, timedOut: true }), ACK_DEADLINE_MS);
    }),
  ]);
  clearTimeout(ackTimer);

  if (outcome.ok) {
    sendJson(res, outcome.status ?? 200, { accepted: true, mode, upstreamStatus: outcome.status });
    return;
  }
  // Intuit retry-storms on non-2xx; a broken tunnel is our problem, not a
  // reason to make it redeliver. The delivery log keeps the real outcome.
  sendJson(res, 202, {
    accepted: true,
    mode,
    pending: Boolean(outcome.timedOut),
    error: outcome.error ?? null,
  });
}

function statusPayload() {
  return {
    mode: state.mode,
    target: state.target || null,
    appUrl: PRIMARY_URL,
    updatedAt: state.updatedAt,
    modes: MODES,
    deliveries,
  };
}

async function handleControl(req, res, path) {
  if (path === "/_switch/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req)) {
    if (req.method === "GET" && path === "/_switch") {
      sendHtml(res, 401, LOGIN_PAGE);
      return;
    }
    res.setHeader("www-authenticate", 'Bearer realm="webhook-switch"');
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && path === "/_switch") {
    sendHtml(res, 200, CONTROL_PAGE);
    return;
  }
  if (req.method === "GET" && path === "/_switch/status") {
    sendJson(res, 200, statusPayload());
    return;
  }
  if (req.method === "POST" && (path === "/_switch" || path === "/_switch/status")) {
    let parsed;
    try {
      const raw = await readBody(req);
      parsed = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      sendJson(res, 400, { error: "invalid json body" });
      return;
    }
    const next = { ...state };
    if (parsed.mode !== undefined) {
      if (!MODES.includes(parsed.mode)) {
        sendJson(res, 400, { error: `mode must be one of ${MODES.join(", ")}` });
        return;
      }
      next.mode = parsed.mode;
    }
    if (parsed.target !== undefined) {
      if (parsed.target === null || parsed.target === "") {
        next.target = "";
      } else {
        let url;
        try {
          url = new URL(String(parsed.target));
        } catch {
          sendJson(res, 400, { error: "target must be an absolute http(s) url" });
          return;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          sendJson(res, 400, { error: "target must be an absolute http(s) url" });
          return;
        }
        next.target = url.href.replace(/\/+$/, "");
      }
    }
    if ((next.mode === "forward" || next.mode === "both") && !next.target) {
      sendJson(res, 400, { error: `mode "${next.mode}" needs a target url` });
      return;
    }
    next.updatedAt = new Date().toISOString();
    state = next;
    saveState();
    console.log(`[switch] mode=${state.mode} target=${state.target || "(unset)"}`);
    sendJson(res, 200, statusPayload());
    return;
  }
  sendJson(res, 405, { error: "method not allowed" });
}

const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/_switch" || path.startsWith("/_switch/")) {
    handleControl(req, res, path).catch((err) => sendJson(res, 500, { error: err.message }));
    return;
  }
  handleWebhook(req, res).catch((err) => sendJson(res, 500, { error: err.message }));
});

const STYLE = `
:root{color-scheme:dark}
body{margin:0;padding:2rem;background:#12141a;color:#e6e8ee;
 font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
h1{font-size:1.1rem;margin:0 0 .25rem}
p.sub{color:#8b93a7;margin:0 0 1.5rem}
fieldset{border:1px solid #2a2f3d;border-radius:8px;padding:1rem;margin:0 0 1rem;max-width:52rem}
legend{color:#8b93a7;padding:0 .4rem}
button{font:inherit;background:#232838;color:#e6e8ee;border:1px solid #39405a;
 border-radius:6px;padding:.4rem .9rem;cursor:pointer}
button:hover{background:#2d3348}
button.on{background:#2f6f4f;border-color:#3f8f66}
input{font:inherit;background:#0e1016;color:#e6e8ee;border:1px solid #39405a;
 border-radius:6px;padding:.4rem .6rem;min-width:22rem}
table{border-collapse:collapse;width:100%;max-width:52rem}
th,td{text-align:left;padding:.3rem .6rem;border-bottom:1px solid #22263180;white-space:nowrap}
th{color:#8b93a7;font-weight:400}
.ok{color:#5fd08a}.bad{color:#f2777a}
#msg{min-height:1.4em;color:#f2777a}
`;

const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><title>webhook switch</title>
<style>${STYLE}</style>
<h1>webhook switch</h1><p class="sub">admin token required</p>
<fieldset><legend>sign in</legend>
<input id="t" type="password" placeholder="SWITCH_ADMIN_TOKEN" autofocus>
<button onclick="go()">unlock</button></fieldset>
<script>
function go(){sessionStorage.setItem('switchToken',document.getElementById('t').value);location.reload()}
document.getElementById('t').addEventListener('keydown',e=>{if(e.key==='Enter')go()});
</script>`;

const CONTROL_PAGE = `<!doctype html><meta charset="utf-8"><title>webhook switch</title>
<style>${STYLE}</style>
<h1>webhook switch</h1>
<p class="sub">/webhooks/* deliveries arriving at this host are routed to:</p>
<fieldset><legend>mode</legend>
  <button data-mode="local">local &rarr; VM app</button>
  <button data-mode="forward">forward &rarr; target</button>
  <button data-mode="both">both</button>
  <span id="msg"></span>
</fieldset>
<fieldset><legend>target url (tunnel to your laptop)</legend>
  <input id="target" placeholder="https://xxxx.ngrok-free.app">
  <button onclick="save({target:document.getElementById('target').value})">save</button>
</fieldset>
<fieldset><legend>recent deliveries</legend>
  <table><thead><tr><th>at</th><th>path</th><th>mode</th><th>role</th>
  <th>destination</th><th>status</th><th>ms</th></tr></thead><tbody id="log"></tbody></table>
</fieldset>
<script>
const token = sessionStorage.getItem('switchToken') || '';
const hdrs = {authorization: 'Bearer ' + token, 'content-type': 'application/json'};
async function refresh(){
  const r = await fetch('/_switch/status', {headers: hdrs});
  if (r.status === 401){ sessionStorage.removeItem('switchToken'); location.reload(); return; }
  render(await r.json());
}
async function save(patch){
  const r = await fetch('/_switch', {method:'POST', headers: hdrs, body: JSON.stringify(patch)});
  const body = await r.json();
  document.getElementById('msg').textContent = r.ok ? '' : (body.error || 'failed');
  if (r.ok) render(body);
}
function render(s){
  for (const b of document.querySelectorAll('[data-mode]'))
    b.classList.toggle('on', b.dataset.mode === s.mode);
  const t = document.getElementById('target');
  if (document.activeElement !== t) t.value = s.target || '';
  document.getElementById('log').innerHTML = s.deliveries.map(d =>
    '<tr><td>' + d.at.slice(11,23) + '</td><td>' + esc(d.path) + '</td><td>' + d.mode +
    '</td><td>' + d.role + '</td><td>' + esc(d.destination) + '</td><td class="' +
    (d.status && d.status < 400 ? 'ok' : 'bad') + '">' + (d.status || esc(d.error || '')) +
    '</td><td>' + d.ms + '</td></tr>').join('');
}
function esc(v){const e=document.createElement('span');e.textContent=v;return e.innerHTML}
for (const b of document.querySelectorAll('[data-mode]'))
  b.onclick = () => save({mode: b.dataset.mode});
refresh(); setInterval(refresh, 2000);
</script>`;

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[switch] listening on :${PORT} mode=${state.mode} target=${state.target || "(unset)"} app=${PRIMARY_URL}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
