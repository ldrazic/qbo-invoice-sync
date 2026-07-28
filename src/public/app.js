"use strict";

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
};

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

function toast(msg, kind = "", title) {
  const t = el("div", { class: `toast ${kind}` },
    title ? el("div", { class: "t-title" }, title) : null,
    el("div", {}, msg));
  $("#toasts").append(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, 4200);
}

const money = (dollars) => `$${Number(dollars).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortId = (id) => (id ? String(id).slice(0, 8) : "—");
const ago = (iso) => {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.documentElement.dataset.tab = b.dataset.go;
    if (b.dataset.go === "schematic") renderSchematic();
  }),
);

// ---------------------------------------------------------------------------
// status strip
// ---------------------------------------------------------------------------
async function refreshStatus() {
  try {
    await api("/health");
    $("#health-dot").className = "dot ok";
  } catch { $("#health-dot").className = "dot off"; }

  try {
    const s = await api("/admin/qbo-status");
    const dot = $("#qbo-dot"), txt = $("#qbo-txt"), slot = $("#connect-slot");
    if (s.connected) {
      dot.className = "dot ok";
      txt.innerHTML = s.realmId ? `QuickBooks <b>· realm ${s.realmId}</b>` : `provider: ${s.provider}`;
      slot.innerHTML = ""; slot.dataset.shown = "";
    } else {
      dot.className = "dot off";
      txt.textContent = "QuickBooks not connected";
      if (!slot.dataset.shown) {
        slot.dataset.shown = "1";
        slot.append(el("div", { class: "connect-banner" },
          el("div", { class: "txt", html: "<b>QuickBooks isn't connected.</b> Authorize the sandbox company to start syncing." }),
          el("a", { class: "btn primary", href: "/qbo/connect" }, "Connect QuickBooks")));
      }
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// console: create form
// ---------------------------------------------------------------------------
function lineRow(item = "Services", qty = 1, unit = "") {
  const row = el("div", { class: "line-row" },
    el("input", { value: item, placeholder: "Item (QBO name)", "aria-label": "item" }),
    el("input", { value: qty, type: "number", min: "1", "aria-label": "quantity" }),
    el("input", { value: unit, type: "number", min: "0", step: "0.01", placeholder: "0.00", "aria-label": "unit price" }),
    el("button", { class: "rm", title: "remove", onclick: () => { row.remove(); updateTotal(); } }, "×"));
  row.querySelectorAll("input").forEach((i) => i.addEventListener("input", updateTotal));
  return row;
}
function readLines() {
  return [...document.querySelectorAll("#lines .line-row")].map((r) => {
    const [item, qty, unit] = r.querySelectorAll("input");
    return {
      itemCode: item.value.trim() || "Services",
      quantity: Math.max(1, parseInt(qty.value || "1", 10)),
      unitPriceCents: Math.round(parseFloat(unit.value || "0") * 100),
    };
  });
}
function updateTotal() {
  const cents = readLines().reduce((s, l) => s + l.quantity * l.unitPriceCents, 0);
  $("#total-preview").textContent = money(cents / 100);
}

async function loadCustomers() {
  const custs = await api("/internal/customers");
  const sel = $("#customer-select");
  const cur = sel.value;
  sel.innerHTML = "";
  if (custs.length === 0) {
    sel.append(el("option", { value: "" }, "— create a customer first —"));
  }
  custs.forEach((c) => sel.append(el("option", { value: c.id }, c.name)));
  if (cur) sel.value = cur;
  return custs;
}

// ---------------------------------------------------------------------------
// console: invoices
// ---------------------------------------------------------------------------
let linkIndex = {}; // internalId -> link

function invoiceCard(inv) {
  const link = linkIndex[inv.id];
  const actions = el("div", { class: "inv-actions" });
  const terminal = inv.status === "voided" || inv.status === "deleted";
  if (!terminal) {
    if (inv.status !== "paid")
      actions.append(el("button", { class: "btn sm", onclick: () => payDialog(inv) }, "Record payment"));
    actions.append(el("button", { class: "btn sm ghost", onclick: () => noteDialog(inv) }, "Edit note"));
    actions.append(el("button", { class: "btn sm ghost danger", onclick: () => voidInvoice(inv) }, "Void"));
    actions.append(el("button", { class: "btn sm ghost danger", onclick: () => deleteInvoice(inv) }, "Delete"));
  } else {
    actions.append(el("span", { class: "eyebrow" }, `${inv.status} — no further edits`));
  }

  return el("div", { class: "inv" },
    el("div", { class: "inv-top" },
      el("span", { class: "inv-doc" }, inv.docNumber),
      el("span", { class: "inv-cust" }, inv.customerName),
      el("span", { class: `badge ${inv.status}` }, inv.status),
      el("span", { class: "inv-amt" }, money(inv.total))),
    el("div", { class: "inv-meta" },
      el("span", { class: "tag-int", html: ` <b>${shortId(inv.id)}</b> · v${inv.version}` }),
      link
        ? el("span", { class: "tag-qbo", html: ` <b>id ${link.externalId}</b> · token ${link.externalSyncToken ?? "—"}` })
        : el("span", { class: "unlinked mono" }, "⋯ syncing to quickbooks"),
      inv.status === "partial" || Number(inv.balanceCents) !== 0
        ? el("span", {}, `balance ${money(inv.balance)}`) : null),
    actions);
}

async function loadInvoices() {
  const [invoices, links] = await Promise.all([api("/internal/invoices"), api("/admin/links")]);
  linkIndex = {};
  links.filter((l) => l.entityType === "invoice").forEach((l) => { linkIndex[l.internalId] = l; });

  const list = $("#inv-list");
  list.innerHTML = "";
  $("#inv-count").textContent = invoices.length ? `${invoices.length} total` : "";
  if (invoices.length === 0) {
    list.append(el("div", { class: "panel" }, el("div", { class: "empty" }, "No invoices yet. Create one on the left — it'll sync to QuickBooks within a second or two.")));
    return;
  }
  invoices.forEach((inv) => list.append(invoiceCard(inv)));
  renderLinks(links);
}

function renderLinks(links) {
  const slot = $("#links-slot");
  if (links.length === 0) { slot.innerHTML = ""; slot.append(el("div", { class: "empty" }, "No links yet.")); return; }
  const rows = links.slice(0, 12).map((l) =>
    el("tr", {},
      el("td", { class: `etype-${l.entityType}` }, l.entityType),
      el("td", { class: "id" }, shortId(l.internalId)),
      el("td", { class: "id" }, l.externalId),
      el("td", {}, l.externalSyncToken ?? "—")));
  slot.innerHTML = "";
  slot.append(el("table", { class: "links" },
    el("thead", {}, el("tr", {},
      el("th", {}, "type"), el("th", {}, "internal"), el("th", {}, "qbo id"), el("th", {}, "token"))),
    el("tbody", {}, ...rows)));
}

// ---------------------------------------------------------------------------
// console: activity feed
// ---------------------------------------------------------------------------
const ACTION_LABEL = {
  applied: "applied", linked_existing: "linked existing", conflict_lww: "conflict · last-write-wins",
  applied_divergent: "applied · provider reallocated",
  recovered_orphan_write: "recovered orphan write", skipped_echo: "skipped echo",
  skipped_duplicate: "skipped duplicate", skipped_noop: "skipped no-op", skipped_stale: "skipped stale",
  failed: "failed",
};
function feedDetail(a) {
  const d = a.detail || {};
  if (d.direction) {
    const dir = d.direction === "internal->external" ? "internal → quickbooks" : "quickbooks → internal";
    const base = `${dir}${d.docNumber ? " · " + d.docNumber : ""}${d.amountCents ? " · " + money(d.amountCents / 100) : ""}`;
    return d.divergence ? `${base} · ${d.divergence}` : base;
  }
  if (d.decision) return `${d.decision.replace("_", " ")}${d.wroteExternal ? " · wrote qbo" : ""}${d.wroteInternal ? " · wrote internal" : ""}`;
  if (d.reason) return d.reason;
  return "";
}
async function loadFeed() {
  const audit = await api("/admin/audit");
  const feed = $("#feed");
  feed.innerHTML = "";
  $("#feed-count").textContent = audit.length ? `${audit.length}` : "";
  if (audit.length === 0) { feed.append(el("div", { class: "empty" }, "Sync decisions will stream here.")); return; }
  audit.slice(0, 40).forEach((a) => {
    feed.append(el("div", { class: "ev" },
      el("div", { class: "rail" }, el("div", { class: `node ${a.action}` })),
      el("div", { class: "body" },
        el("div", { class: "act" }, el("span", { class: `a-${a.action}` }, ACTION_LABEL[a.action] || a.action)),
        el("div", { class: "det" }, feedDetail(a)),
        el("div", { class: "when" }, ago(a.createdAt)))));
  });
}

// ---------------------------------------------------------------------------
// console: mini modal + actions
// ---------------------------------------------------------------------------
function modal(title, fields, onSubmit) {
  const overlay = el("div", {
    style: "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:70;display:flex;align-items:center;justify-content:center",
    onclick: (e) => { if (e.target === overlay) overlay.remove(); },
  });
  const inputs = {};
  const form = el("form", { class: "panel", style: "width:340px",
    onsubmit: (e) => { e.preventDefault(); const vals = {}; for (const k in inputs) vals[k] = inputs[k].value; onSubmit(vals, overlay); } });
  form.append(el("div", { class: "phead" }, el("h2", {}, title)));
  const bodyEl = el("div", { class: "pbody" });
  fields.forEach((f) => {
    const input = el("input", { value: f.value ?? "", type: f.type || "text", placeholder: f.placeholder || "" });
    if (f.step) input.step = f.step;
    inputs[f.key] = input;
    bodyEl.append(el("label", { class: "field" }, el("span", {}, f.label), input));
  });
  bodyEl.append(el("button", { class: "btn primary wide", type: "submit" }, "Confirm"));
  form.append(bodyEl);
  overlay.append(form);
  document.body.append(overlay);
  const first = form.querySelector("input"); if (first) first.focus();
}

function payDialog(inv) {
  modal(`Record payment · ${inv.docNumber}`, [
    { key: "amount", label: "Amount (USD)", type: "number", step: "0.01", value: inv.balance },
  ], async (v, ov) => {
    try {
      await api(`/internal/invoices/${inv.id}/payments`, { method: "POST", body: JSON.stringify({ amountCents: Math.round(parseFloat(v.amount) * 100), method: "transfer" }) });
      ov.remove(); toast(`Payment of ${money(v.amount)} recorded — syncing to QuickBooks`, "ok", "Payment");
      refreshConsole();
    } catch (e) { toast(e.message, "err", "Error"); }
  });
}
function noteDialog(inv) {
  modal(`Edit note · ${inv.docNumber}`, [
    { key: "note", label: "Note", value: inv.notes || "" },
  ], async (v, ov) => {
    try {
      const lines = inv.lines.map((l) => ({ itemCode: l.itemCode, description: l.description, quantity: l.quantity, unitPriceCents: Math.round(parseFloat(l.unitPrice) * 100) }));
      await api(`/internal/invoices/${inv.id}`, { method: "PUT", body: JSON.stringify({ notes: v.note, lines }) });
      ov.remove(); toast("Note updated — syncing to QuickBooks", "ok", "Updated");
      refreshConsole();
    } catch (e) { toast(e.message, "err", "Error"); }
  });
}
async function voidInvoice(inv) {
  if (!confirm(`Void ${inv.docNumber}? In QuickBooks this becomes a void (zeroed, kept for audit).`)) return;
  try { await api(`/internal/invoices/${inv.id}/void`, { method: "POST" }); toast(`${inv.docNumber} voided`, "ok", "Voided"); refreshConsole(); }
  catch (e) { toast(e.message, "err", "Error"); }
}
async function deleteInvoice(inv) {
  if (!confirm(`Delete ${inv.docNumber}? Internally it's soft-deleted; in QuickBooks it maps to a void to preserve the audit trail.`)) return;
  try { await api(`/internal/invoices/${inv.id}`, { method: "DELETE" }); toast(`${inv.docNumber} deleted`, "ok", "Deleted"); refreshConsole(); }
  catch (e) { toast(e.message, "err", "Error"); }
}

// ---------------------------------------------------------------------------
// console: wire form
// ---------------------------------------------------------------------------
$("#add-line").addEventListener("click", () => { $("#lines").append(lineRow()); });
$("#add-cust").addEventListener("click", async () => {
  const name = $("#new-cust-name").value.trim();
  if (!name) return;
  try {
    const c = await api("/internal/customers", { method: "POST", body: JSON.stringify({ name }) });
    $("#new-cust-name").value = "";
    await loadCustomers();
    $("#customer-select").value = c.id;
    toast(`Customer "${name}" added`, "ok", "Customer");
  } catch (e) { toast(e.message, "err", "Error"); }
});
$("#create-inv").addEventListener("click", async () => {
  const customerId = $("#customer-select").value;
  if (!customerId) { toast("Pick or create a customer first", "err", "Missing customer"); return; }
  const lines = readLines().filter((l) => l.unitPriceCents > 0);
  if (lines.length === 0) { toast("Add at least one line with a price", "err", "Missing lines"); return; }
  const btn = $("#create-inv"); btn.disabled = true; btn.textContent = "Creating…";
  try {
    const inv = await api("/internal/invoices", { method: "POST", body: JSON.stringify({ customerId, notes: $("#inv-note").value.trim() || null, lines }) });
    toast(`${inv.docNumber} created — syncing to QuickBooks`, "ok", "Invoice");
    $("#inv-note").value = "";
    $("#lines").innerHTML = ""; $("#lines").append(lineRow());
    updateTotal();
    refreshConsole();
  } catch (e) { toast(e.message, "err", "Error"); }
  finally { btn.disabled = false; btn.innerHTML = "Create &amp; sync to QuickBooks"; }
});

// ---------------------------------------------------------------------------
// console refresh loop
// ---------------------------------------------------------------------------
async function refreshConsole() {
  try { await Promise.all([loadInvoices(), loadFeed()]); } catch (e) { /* transient */ }
}
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  const tick = async () => {
    if (document.documentElement.dataset.tab === "console" && !document.hidden) {
      await refreshStatus(); await refreshConsole();
    }
    pollTimer = setTimeout(tick, 2500);
  };
  tick();
}

// ---------------------------------------------------------------------------
// SCHEMATIC
// ---------------------------------------------------------------------------
const NODES = [
  { id: "src-int", lane: "int", k: "source · internal", t: "Internal change", d: "Create / update / void / delete / payment emits a webhook.",
    detail: "The internal invoicing system is a real service here (CRUD in Postgres). Every mutation fires a webhook to the sync engine — deliberately treated as an untrusted hint, because in the real world these can be duplicated, delayed, or arrive out of order.",
    qbo: null },
  { id: "src-qbo", lane: "qbo", k: "source · quickbooks", t: "QuickBooks change", d: "A user edits in the QBO UI; QBO fires a webhook.",
    detail: "QuickBooks webhooks carry only { realmId, entity, id, operation, lastUpdated } — never the invoice body. The request is authenticated with an HMAC-SHA256 signature over the exact raw bytes, verified before the payload is parsed.",
    qbo: "POST /webhooks/qbo · header intuit-signature = base64(HMAC-SHA256(rawBody, verifierToken))" },
  { id: "inbox", lane: "eng", k: "step 01 · ingest", t: "Inbox — dedupe", d: "Persist raw event under a unique key; duplicates are no-ops.",
    detail: "Each event is inserted into an inbox table keyed by (source, entity, id, operation, version). The insert is ON CONFLICT DO NOTHING, so a redelivered webhook is dropped at the door — idempotency happens before any real work.",
    qbo: "dedupe key includes QBO's lastUpdated so genuine new edits still pass" },
  { id: "claim", lane: "eng", k: "step 02 · queue", t: "Worker claim", d: "FOR UPDATE SKIP LOCKED + a lease on each event.",
    detail: "The same inbox table is the work queue. A worker claims the next due event with SELECT … FOR UPDATE SKIP LOCKED and stamps a lease (locked_until). Multiple workers never collide, and if one crashes mid-event the lease expires and another reclaims it.",
    qbo: null },
  { id: "refetch", lane: "eng", k: "step 03 · read", t: "Refetch both sides", d: "Never trust the event body — read current state fresh.",
    detail: "The engine refetches the entity from both the internal DB and QuickBooks. Because processing always starts from current state, duplicate and out-of-order events converge on the same result instead of corrupting anything.",
    qbo: "GET /v3/company/{realmId}/invoice/{id} — or a DocNumber query on the recovery path" },
  { id: "echo", lane: "eng", k: "step 04 · guard", t: "Echo suppression", d: "Skip the webhook our own write just caused.",
    detail: "When the engine writes to QBO, QBO emits a webhook for that change. If the event-side state already equals the last synced snapshot, it's our own echo (or a stale event) and is skipped — no infinite write loop.",
    qbo: null },
  { id: "resolve", lane: "eng", k: "step 05 · reconcile", t: "Resolve — last write wins", d: "Compare both sides against the last synced snapshot.",
    detail: "The last synced snapshot is the common ancestor. If only one side changed, propagate it. If both changed, the more recently modified side wins wholesale; ties go to QuickBooks as the system of record. The overwritten state is preserved in the audit log, so nothing is lost silently.",
    qbo: "internal updated_at vs QBO MetaData.LastUpdatedTime decides the winner" },
  { id: "apply", lane: "eng", k: "step 06 · write", t: "Apply under optimistic lock", d: "SyncToken + version; stale → refetch, not overwrite.",
    detail: "Writes go out under an optimistic lock: QBO's SyncToken and the internal version. A stale token is rejected (QBO fault 5010), which triggers a refetch and re-resolve rather than a blind overwrite. Creates are idempotent — the internal DocNumber is stamped onto the QBO invoice, and a lookup-by-DocNumber precedes any create-retry, so a timeout-after-write never duplicates.",
    qbo: "POST /v3/company/{realmId}/invoice with Id + SyncToken · fault 5010 = stale token" },
  { id: "w-int", lane: "int", k: "write · internal", t: "Write internal", d: "Apply merged state, bump version.",
    detail: "When the resolution says the internal record must change, the engine applies the merged state and bumps its version — the internal analog of a SyncToken.",
    qbo: null },
  { id: "w-qbo", lane: "qbo", k: "write · quickbooks", t: "Write QuickBooks", d: "Create / update / void via the QBO REST API.",
    detail: "Create, update, or void in QuickBooks. An internal delete maps to a QBO void — hard-deleting would destroy the accounting audit trail. A QBO hard-delete maps back to an internal soft-delete.",
    qbo: "?operation=void keeps a zeroed record · ?operation=delete removes it entirely" },
  { id: "persist", lane: "eng", k: "step 07 · commit", t: "Advance snapshot + audit", d: "Record the new common ancestor and the decision.",
    detail: "On success the engine stores the new common ancestor (snapshot + hash + both version tokens) on the entity link, and writes an audit row explaining what changed, what was decided, and whether it succeeded — the trail you can replay to explain any invoice's history.",
    qbo: null },
];

const DECISIONS = [
  { k: "idempotency", t: "Idempotent ingestion", p: "Every event is deduped at the inbox by a unique key before processing. Duplicate webhook deliveries and retries can't create duplicate records or repeat writes." },
  { k: "conflicts", t: "Last-write-wins", p: "Concurrent edits resolve by most-recent modification time; ties go to QuickBooks as the system of record.", trade: "Wholesale overwrite of the losing side, and correctness depends on both systems' clocks. In exchange the system is always convergent and never blocks on a human." },
  { k: "concurrency", t: "Optimistic locking both ways", p: "QBO's SyncToken and an internal version guard every write. A stale token triggers a refetch-and-re-resolve instead of clobbering a newer edit." },
  { k: "reliability", t: "Timeout-after-write recovery", p: "The internal DocNumber is written onto the QBO invoice; a lookup-by-DocNumber precedes any create-retry, so a write that timed out after being applied is recovered, never duplicated." },
  { k: "semantics", t: "Delete → Void", p: "An internal delete becomes a QBO void, not a hard delete.", trade: "The two systems aren't byte-identical after a delete, but the accounting audit trail is preserved — the correct choice for a system of record." },
  { k: "auth", t: "Token persistence & refresh", p: "OAuth access/refresh tokens live in Postgres and refresh automatically; concurrent refreshes are serialized because QBO rotates the refresh token on every use." },
  { k: "modeling", t: "Money as integer cents", p: "All amounts are integer cents end to end; decimal strings exist only at the API edges. No floating-point drift in financial data." },
  { k: "architecture", t: "Provider behind a port", p: "All QuickBooks specifics live behind an AccountingProvider interface resolved by a factory. Swapping to Xero is a new adapter, not a rewrite — the same interface backs the in-memory fake used in tests." },
  { k: "infrastructure", t: "Durable queue on Postgres", p: "Inbox, queue, links, and audit are one transactional store — no Redis or Kafka to operate.", trade: "Single-node throughput ceiling; the design maps cleanly onto a partitioned log if that ceiling is ever hit." },
  { k: "future", t: "Reconciliation sweep", p: "Planned: a periodic QBO Change-Data-Capture poll plus internal scan to catch missed webhooks and backfill pre-existing records. The inbox already accepts a reconciliation source." },
];

let schematicBuilt = false;
function renderSchematic() {
  if (schematicBuilt) return;
  schematicBuilt = true;
  const flow = $("#flow");

  const nodeEl = (n) => el("button", { class: `gnode ${n.lane}`, "data-id": n.id, onclick: () => selectNode(n.id) },
    el("div", { class: "n-k" }, n.k),
    el("div", { class: "n-t" }, n.t),
    el("div", { class: "n-d" }, n.d));
  const connEl = (c) => el("div", { class: `connector ${c.flowing ? "flowing" : ""}` });

  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  const seq = [
    el("div", { class: "pair" }, nodeEl(byId["src-int"]), nodeEl(byId["src-qbo"])),
    connEl({ flowing: true }),
    nodeEl(byId["inbox"]), connEl({ flowing: true }),
    nodeEl(byId["claim"]), connEl({ flowing: true }),
    nodeEl(byId["refetch"]), connEl({ flowing: false }),
    nodeEl(byId["echo"]), connEl({ flowing: true }),
    nodeEl(byId["resolve"]), connEl({ flowing: true }),
    nodeEl(byId["apply"]), connEl({ flowing: true }),
    el("div", { class: "pair" }, nodeEl(byId["w-int"]), nodeEl(byId["w-qbo"])),
    connEl({ flowing: true }),
    nodeEl(byId["persist"]),
  ];
  seq.forEach((n) => flow.append(n));

  const dg = $("#decisions");
  DECISIONS.forEach((d) => dg.append(el("div", { class: "dcard" },
    el("div", { class: "dc-k" }, d.k),
    el("h3", {}, d.t),
    el("p", {}, d.p),
    d.trade ? el("div", { class: "tradeoff", html: `<b>trade-off</b> — ${d.trade}` }) : null)));

  selectNode("resolve");
}

function selectNode(id) {
  const n = NODES.find((x) => x.id === id);
  document.querySelectorAll(".gnode").forEach((g) => g.classList.toggle("active", g.dataset.id === id));
  const d = $("#detail");
  d.innerHTML = "";
  d.append(el("div", { class: "d-head" },
    el("div", { class: "d-k" }, n.k),
    el("div", { class: "d-t" }, n.t)));
  const body = el("div", { class: "d-body" });
  body.append(el("p", {}, n.detail));
  if (n.qbo) {
    body.append(el("div", { class: "d-sub" }, "QuickBooks API"));
    body.append(el("div", { class: "qbo-map" }, el("div", { class: "qm-k" }, "how it maps"), el("p", {}, n.qbo)));
  }
  d.append(body);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async function boot() {
  $("#lines").append(lineRow("Services", 1, ""));
  updateTotal();
  await refreshStatus();
  await loadCustomers().catch(() => {});
  await refreshConsole();
  startPolling();
})();
