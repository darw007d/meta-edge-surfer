// Meta-Edge Surfer — vanilla SPA for the OMEGA mesh.
// Three views: Inbox / Send / 48h Highlights. Plus a Settings tab for the
// bearer token + base URL. State lives in localStorage; all API calls go
// to mesh-gateway with bearer auth.

const LS = {
  base: "mes.base",
  token: "mes.token",
  poll: "mes.poll",
  expanded: "mes.expanded",  // session set of expanded msg ids
};

// On a public HTTPS front the gateway is reached same-origin via the /gw relay
// (the firewalled :8788 isn't publicly reachable). Dev/tailnet keeps :8788 direct.
const DEFAULT_BASE = location.protocol === "https:"
  ? `${location.origin}/gw`
  : `${location.protocol}//${location.hostname}:8788`;
const COMMANDER = "commander";
const AI_PEERS = ["droplet", "lab-ovh", "gpu-wsl", "razorpeter", "science-claude"];
const KIND_LABELS = ["fyi", "answer", "question", "status", "unblock"];

// ---------- state ----------
const state = {
  base: localStorage.getItem(LS.base) || DEFAULT_BASE,
  token: localStorage.getItem(LS.token) || "",
  pollSec: parseInt(localStorage.getItem(LS.poll) || "30", 10),
  pollTimer: null,
  peers: [],          // populated after first /peers fetch
  inbox: [],          // most recent first
  expanded: new Set(),
};

// True once a Meta-Edge SSO session is driving state.token (vs a manual paste).
let ssoActive = false;

// Migrate a base saved before the /gw relay existed: a public HTTPS front can't
// reach the firewalled :8788 directly, so rewrite it to the same-origin relay.
if (location.protocol === "https:" && /:8788\/?$/.test(state.base)) {
  state.base = `${location.origin}/gw`;
  localStorage.setItem(LS.base, state.base);
}

// ---------- tiny helpers ----------
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const now = Date.now();
  const ago = (now - d.getTime()) / 1000;
  if (ago < 60) return `${Math.floor(ago)}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
// Humanize the common cron shapes; fall back to the raw expr otherwise.
const _DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function humanizeCron(expr) {
  if (typeof expr !== "string") return "";
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [min, hr, dom, mon, dow] = f;
  const time = (/^\d+$/.test(hr) && /^\d+$/.test(min))
    ? `${hr.padStart(2, "0")}:${min.padStart(2, "0")} UTC` : null;
  if (time && dom === "*" && mon === "*" && /^[0-6]$/.test(dow)) return `${_DOW[+dow]} ${time}`;
  if (time && dom === "*" && mon === "*" && dow === "*") return `daily ${time}`;
  return expr;
}

function setStatus(text, cls = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = "status " + cls;
}

// ---------- API ----------
async function api(path, opts = {}) {
  if (!state.token) throw new Error("no token configured — open Settings");
  const url = state.base.replace(/\/$/, "") + path;
  const doFetch = () => {
    const headers = { "Authorization": "Bearer " + state.token, ...(opts.headers || {}) };
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    return fetch(url, { ...opts, headers });
  };
  let res = await doFetch();
  // SSO identity tokens are short-lived: refresh once on 401 and retry.
  if (res.status === 401 && ssoActive) {
    const tok = await ssoIdentityToken();
    if (tok) { state.token = tok; res = await doFetch(); }
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail || ""; } catch {}
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return res.json();
}

// ---------- SSO (Meta-Edge identity) ----------
// The auth backend (meta-edge-auth) is same-origin /auth/* in production (nginx).
// Login sets an httpOnly cookie; we exchange it for a short-lived RS256 identity
// JWT held in MEMORY (never localStorage — it's a gateway-trusted bearer).
// Degrades silently to the manual token when no auth backend is present (dev).
async function ssoIdentityToken() {
  try {
    const r = await fetch("/auth/identity-token", { credentials: "include" });
    if (!r.ok) return null;
    return (await r.json()).token || null;
  } catch { return null; }
}
async function trySsoBoot() {
  try {
    const me = await fetch("/auth/me", { credentials: "include" });
    if (!me.ok) return false;
    const info = await me.json();
    if (!info.authenticated) return false;
    const tok = await ssoIdentityToken();
    if (!tok) return false;
    state.token = tok;        // in memory only — never localStorage
    state.ssoLogin = info.login || "";
    state.ssoProvider = info.provider || "";
    ssoActive = true;
    return true;
  } catch { return false; }
}
async function ssoLogout() {
  try { await fetch("/auth/logout", { method: "POST", credentials: "include" }); } catch {}
  ssoActive = false;
  state.token = "";
}

// Settings reflects the connection: when signed in via SSO, show "Connected as X"
// + Sign out and hide the sign-in buttons; otherwise show the buttons.
function renderAuthState() {
  const status = $("#sso-status");
  const block = document.querySelector(".sso-block");
  if (!status) return;
  if (ssoActive) {
    const esc = (s) => String(s).replace(/[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const who = esc(state.ssoLogin || "you");
    const prov = (state.ssoProvider || "sso");
    const provLabel = esc(prov.charAt(0).toUpperCase() + prov.slice(1));
    status.innerHTML =
      `<div class="sso-connected">✓ Connected as <b>${who}</b> · ${provLabel}` +
      ` <button id="sso-logout" type="button" class="btn-secondary">Sign out</button></div>`;
    status.classList.remove("hidden");
    if (block) block.style.display = "none";   // beat .sso-block's display:flex
    const tl = document.querySelector("#cfg-token")?.closest("label");
    if (tl) tl.style.display = "none";          // hide the manual token field on SSO
    const lo = $("#sso-logout");
    if (lo) lo.addEventListener("click", async () => { await ssoLogout(); location.reload(); });
  } else {
    status.classList.add("hidden");
    if (block) block.style.display = "";
    const tl = document.querySelector("#cfg-token")?.closest("label");
    if (tl) tl.style.display = "";
  }
}
const apiPeers = () => api("/peers");
const apiInbox = (limit = 50) =>
  api(`/messages?to=${COMMANDER}&limit=${limit}`);
const apiAll = (limit = 200) => api(`/messages?limit=${limit}`);
const apiSend = (to_node, kind, content) =>
  api("/messages", {
    method: "POST",
    body: JSON.stringify({ from_node: COMMANDER, to_node, kind, content }),
  });
const apiSchedEvents = () => api("/scheduled-events");
const apiSchedToggle = (name, enable) =>
  api(`/scheduled-events/${encodeURIComponent(name)}/${enable ? "enable" : "disable"}`,
      { method: "POST" });
const apiServices = () => api("/services");
const apiServiceAction = (lane, action, model) =>
  api(`/services/${encodeURIComponent(lane)}/action`,
      { method: "POST", body: JSON.stringify(model ? { action, model } : { action }) });
const apiLanes = () => api("/lanes");
const apiCreateLane = (name, provider, model, n, context_text) =>
  api("/lanes", { method: "POST", body: JSON.stringify(
    context_text ? { name, provider, model, n, context_text } : { name, provider, model, n }) });
const apiScaleLane = (name, n) =>
  api(`/lanes/${encodeURIComponent(name)}/scale`, { method: "POST", body: JSON.stringify({ n }) });
const apiDeleteLane = (name) =>
  api(`/lanes/${encodeURIComponent(name)}`, { method: "DELETE" });
const apiGetContext = (name) => api(`/lanes/${encodeURIComponent(name)}/context`);
const apiSetContext = (name, context_text, context_files) =>
  api(`/lanes/${encodeURIComponent(name)}/context`,
      { method: "POST", body: JSON.stringify({ context_text, context_files }) });
const apiContextFiles = (name) => api(`/lanes/${encodeURIComponent(name)}/context/files`);

// ---------- views ----------
function showView(name) {
  $$(".view").forEach(v => v.classList.toggle("active", v.id === `view-${name}`));
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === name));
  if (name === "inbox") refreshInbox();
  if (name === "send") populatePeers();
  if (name === "highlights") refreshHighlights();
  if (name === "automations") refreshAutomations();
  if (name === "services") { refreshServices(); refreshLanes(); }
  if (name === "settings") populateSettings();
}

// ---------- inbox ----------
// Render DM content with two link patterns auto-converted to tappable anchors:
//   1. Bare URL (http/https)         → <a href=url target=_blank>url</a>
//   2. Markdown action [label](url)  → <a href=url target=_blank>label</a>
// Everything else is text-escaped (no HTML injection from peer content).
const _URL_RE = /(https?:\/\/[^\s<>"'`]+)/g;
const _MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s<>"'`)]+)\)/g;
function _escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function renderContent(text) {
  // Pass 1: extract markdown links into placeholders so URL pass doesn't double-wrap.
  const slots = [];
  let i = 0;
  let s = text.replace(_MD_LINK_RE, (_, label, url) => {
    const k = ` MDLINK${i++} `;
    slots.push(`<a href="${_escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="action">${_escapeHtml(label)}</a>`);
    return k;
  });
  // Pass 2: escape, then linkify bare URLs.
  s = _escapeHtml(s).replace(_URL_RE, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  // Pass 3: restore markdown-link slots.
  return s.replace(/ MDLINK(\d+) /g, (_, k) => slots[parseInt(k, 10)]);
}
function renderMessages(rootList, msgs) {
  const tpl = $("#tpl-msg");
  rootList.innerHTML = "";
  for (const m of msgs) {
    const li = tpl.content.cloneNode(true);
    const liEl = li.querySelector(".msg");
    liEl.dataset.id = m.id;
    li.querySelector(".msg-from").textContent = m.from_node;
    li.querySelector(".msg-to").textContent = m.to_node;
    const kind = li.querySelector(".msg-kind");
    kind.textContent = m.kind;
    kind.classList.add(m.kind);
    li.querySelector(".msg-time").textContent = fmtTime(m.created_at);
    li.querySelector(".msg-time").title = m.created_at;
    const body = li.querySelector(".msg-body");
    body.innerHTML = renderContent(m.content);
    if (state.expanded.has(m.id)) body.classList.add("expanded");
    body.addEventListener("click", (ev) => {
      // Don't toggle expanded when tapping a link inside the body.
      if (ev.target.tagName === "A") return;
      body.classList.toggle("expanded");
      if (body.classList.contains("expanded")) state.expanded.add(m.id);
      else state.expanded.delete(m.id);
    });
    // Reply: jump to Send pre-filled to answer this sender. Hidden on your own
    // messages (you don't reply to yourself).
    const replyBtn = li.querySelector(".msg-reply");
    if (m.from_node === COMMANDER) {
      replyBtn.remove();
    } else {
      replyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        replyTo(m.from_node);
      });
    }
    rootList.appendChild(li);
  }
}

function renderAutomations(rootList, events) {
  const tpl = $("#tpl-automation");
  rootList.innerHTML = "";
  for (const ev of events) {
    const node = tpl.content.cloneNode(true);
    node.querySelector(".auto-name").textContent = ev.name;
    // trigger line
    let trig;
    if (ev.trigger_type === "time") trig = "⏰ " + humanizeCron(ev.cron);
    else {
      let pk = "";
      try { pk = (JSON.parse(ev.predicate || "{}").kind) || "event"; } catch { pk = "event"; }
      trig = "⚡ " + pk;
    }
    node.querySelector(".auto-trigger").textContent = trig;
    // meta line
    const meta = `→ ${ev.target_cell}` +
      (ev.out_channel ? ` · #${ev.out_channel}` : "") +
      ` · fired ${ev.fire_count}×` +
      (ev.last_fired_at ? ` · last ${fmtTime(ev.last_fired_at)}` : " · never") +
      (ev.last_status ? ` · ${ev.last_status}` : "");
    node.querySelector(".auto-meta").textContent = meta;
    // toggle
    const enabled = !!ev.enabled;
    const card = node.querySelector(".automation-card");
    card.classList.toggle("disabled", !enabled);
    const btn = node.querySelector(".auto-toggle");
    btn.textContent = enabled ? "Enabled" : "Disabled";
    btn.classList.toggle("on", enabled);
    btn.addEventListener("click", () => toggleEvent(ev.name, enabled));
    rootList.appendChild(node);
  }
}

async function refreshInbox() {
  try {
    setStatus("loading…");
    const { messages } = await apiInbox(50);
    state.inbox = messages;
    renderMessages($("#inbox-list"), messages);
    $("#inbox-count").textContent = `${messages.length} message${messages.length === 1 ? "" : "s"}`;
    $("#inbox-empty").classList.toggle("hidden", messages.length > 0);
    setStatus(`ok · ${new Date().toLocaleTimeString()}`, "ok");
  } catch (e) {
    setStatus("err: " + e.message, "err");
  }
}

async function refreshAutomations() {
  try {
    setStatus("loading…");
    const { events } = await apiSchedEvents();
    renderAutomations($("#automations-list"), events);
    $("#automations-count").textContent =
      `${events.length} automation${events.length === 1 ? "" : "s"}`;
    $("#automations-empty").classList.toggle("hidden", events.length > 0);
    setStatus(`ok · ${new Date().toLocaleTimeString()}`, "ok");
  } catch (e) {
    setStatus("err: " + e.message, "err");
  }
}

async function toggleEvent(name, currentlyEnabled) {
  try {
    setStatus(currentlyEnabled ? "disabling…" : "enabling…");
    await apiSchedToggle(name, !currentlyEnabled);
    await refreshAutomations();
  } catch (e) {
    setStatus("err: " + e.message, "err");
  }
}

// ---------- services (LLM fleet) ----------
async function refreshServices() {
  try {
    const { services } = await apiServices();
    renderServices(services);
    $("#services-meta").textContent =
      `${services.filter(s => s.state === "active").length}/${services.length} up`;
  } catch (e) { setStatus("services: " + e.message, "err"); }
}

function renderServices(services) {
  const list = $("#services-list"); list.innerHTML = "";
  const tpl = $("#tpl-service");
  for (const s of services) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    $(".svc-name", li).textContent = `${s.node}  :${s.port}`;
    const dot = $(".svc-state", li);
    dot.textContent = s.state === "active" ? "● on" : "○ OFF";
    dot.className = "svc-state " + (s.state === "active" ? "on" : "off");
    $(".svc-meta", li).textContent = s.model ? `model: ${s.model}` : (s.provider);
    const sel = $(".svc-model", li);
    (s.models_available || []).forEach(m => {
      const o = document.createElement("option");
      o.value = m; o.textContent = m; if (m === s.model) o.selected = true; sel.append(o);
    });
    sel.disabled = (s.models_available || []).length <= 1;
    sel.onchange = () => serviceAction(s.lane, "set-model", sel.value);
    $(".svc-start", li).onclick = () => serviceAction(s.lane, "start");
    $(".svc-stop", li).onclick = () => serviceAction(s.lane, "stop", null, true);
    $(".svc-restart", li).onclick = () => serviceAction(s.lane, "restart", null, true);
    list.append(li);
  }
}

async function serviceAction(lane, action, model = null, disruptive = false) {
  if (disruptive && !confirm(`${action} ${lane}? This disrupts a serving lane.`)) return;
  try {
    setStatus(`${action} ${lane}…`);
    await apiServiceAction(lane, action, model);
    setStatus(`${action} ${lane} ✓`, "ok");
    setTimeout(refreshServices, 1200);   // give systemd a beat
  } catch (e) { setStatus(`${action} ${lane}: ${e.message}`, "err"); }
}

// ---------- launched lanes ----------
// Build each lane card with createElement/textContent (no innerHTML interpolation)
// so a free-form model string can't inject markup. Wiring is via .onclick (CSP-safe).
async function refreshLanes() {
  try {
    const { lanes } = await apiLanes();
    const list = $("#lanes-list");
    list.innerHTML = "";
    for (const l of lanes) {
      const li = document.createElement("li");
      li.className = "service-card";

      const row = document.createElement("div");
      row.className = "svc-row";

      const nameEl = document.createElement("span");
      nameEl.className = "svc-name";
      nameEl.textContent = `${l.name} · ${l.provider}/${l.model}`;
      row.append(nameEl);

      const ctrls = document.createElement("span");
      ctrls.className = "lane-ctrls";

      const nInput = document.createElement("input");
      nInput.className = "lane-n";
      nInput.type = "number";
      nInput.min = "0";
      nInput.max = "8";
      nInput.value = String(l.n);

      const scaleBtn = document.createElement("button");
      scaleBtn.type = "button";
      scaleBtn.className = "lane-scale";
      scaleBtn.textContent = "scale";
      scaleBtn.onclick = async () => {
        try {
          setStatus(`scaling ${l.name}…`);
          await apiScaleLane(l.name, +nInput.value);
          setStatus(`scaled ${l.name} ✓`, "ok");
          refreshLanes();
        } catch (e) { setStatus(`scale ${l.name}: ${e.message}`, "err"); }
      };

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "lane-del";
      delBtn.textContent = "✕";
      delBtn.onclick = async () => {
        if (!confirm(`delete lane ${l.name}? (stops all its workers)`)) return;
        try {
          setStatus(`deleting ${l.name}…`);
          await apiDeleteLane(l.name);
          setStatus(`deleted ${l.name} ✓`, "ok");
          refreshLanes();
        } catch (e) { setStatus(`delete ${l.name}: ${e.message}`, "err"); }
      };

      const ctxBtn = document.createElement("button");
      ctxBtn.type = "button";
      ctxBtn.className = "lane-ctx";
      ctxBtn.textContent = "ctx";

      const editor = document.createElement("div");
      editor.className = "ctx-editor hidden";

      ctxBtn.onclick = async () => {
        if (!editor.classList.contains("hidden")) { editor.classList.add("hidden"); return; }
        editor.classList.remove("hidden");
        await openContextEditor(l.name, editor);
      };

      ctrls.append("×", nInput, scaleBtn, ctxBtn, delBtn);
      row.append(ctrls);
      li.append(row);
      li.append(editor);
      list.append(li);
    }
  } catch (e) { setStatus("lanes: " + e.message, "err"); }
}

// Per-lane context editor: textarea (context_text) + checkbox list of files available
// in the lane's curated dir. createElement/textContent only (no innerHTML) so a
// filename or context string can't inject markup.
async function openContextEditor(laneName, mountEl) {
  mountEl.textContent = "loading…";
  try {
    const [ctx, avail] = await Promise.all([apiGetContext(laneName), apiContextFiles(laneName)]);
    mountEl.textContent = "";
    const ta = document.createElement("textarea");
    ta.className = "ctx-text";
    ta.placeholder = "Standing context / instructions for this lane…";
    ta.value = ctx.context_text || "";
    mountEl.append(ta);
    const chosen = new Set(ctx.context_files || []);
    const boxes = [];
    (avail.files || []).forEach((fn) => {
      const label = document.createElement("label");
      label.className = "ctx-file";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.value = fn; cb.checked = chosen.has(fn);
      boxes.push(cb);
      label.append(cb, document.createTextNode(" " + fn));
      mountEl.append(label);
    });
    if (!(avail.files || []).length) {
      const note = document.createElement("div");
      note.className = "muted";
      note.textContent = "No files in this lane's context dir yet.";
      mountEl.append(note);
    }
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ctx-save";
    save.textContent = "Save context";
    save.onclick = async () => {
      try {
        setStatus(`saving ${laneName} context…`);
        await apiSetContext(laneName, ta.value, boxes.filter((b) => b.checked).map((b) => b.value));
        setStatus(`saved ${laneName} context ✓`, "ok");
      } catch (e) { setStatus(`ctx ${laneName}: ${e.message}`, "err"); }
    };
    mountEl.append(save);
  } catch (e) {
    mountEl.textContent = "";
    const err = document.createElement("div");
    err.className = "muted";
    err.textContent = "context: " + e.message;
    mountEl.append(err);
  }
}

async function createLaneFromForm(ev) {
  ev.preventDefault();
  try {
    setStatus("launching lane…");
    await apiCreateLane(
      $("#nl-name").value.trim(),
      $("#nl-provider").value,
      $("#nl-model").value.trim(),
      +$("#nl-n").value,
      ($("#nl-context") ? $("#nl-context").value.trim() : ""),
    );
    $("#new-lane-form").classList.add("hidden");
    setStatus("lane launched ✓", "ok");
    refreshLanes();
  } catch (e) { setStatus("launch: " + e.message, "err"); }
}

// ---------- send ----------
async function populatePeers() {
  const sel = $("#send-to");
  if (sel.options.length > 0) return;  // already populated
  try {
    const { peers } = await apiPeers();
    state.peers = peers;
    sel.innerHTML = "";
    for (const p of peers) {
      if (p.name === COMMANDER) continue;
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    if (sel.options.length === 0) {
      // fall back to hardcoded list if /peers somehow returns empty
      for (const n of AI_PEERS) {
        const opt = document.createElement("option");
        opt.value = n; opt.textContent = n; sel.appendChild(opt);
      }
    }
  } catch (e) {
    setStatus("peers err: " + e.message, "err");
    for (const n of AI_PEERS) {
      const opt = document.createElement("option");
      opt.value = n; opt.textContent = n; sel.appendChild(opt);
    }
  }
}

async function handleSend(ev) {
  ev.preventDefault();
  const to_node = $("#send-to").value;
  const kind = $("#send-kind").value;
  const content = $("#send-content").value.trim();
  if (!content) return;
  const btn = $("#send-btn");
  btn.disabled = true;
  $("#send-result").textContent = "sending…";
  try {
    const r = await apiSend(to_node, kind, content);
    $("#send-result").textContent = `✓ id=${r.id} sent at ${fmtTime(r.created_at)}`;
    $("#send-content").value = "";
  } catch (e) {
    $("#send-result").textContent = "✗ " + e.message;
  } finally {
    btn.disabled = false;
  }
}

// Jump to the Send view pre-filled to answer a specific peer's DM. Populates the
// peer list FIRST (idempotent) so showView's own populate call early-returns and
// can't wipe the selection we set here.
async function replyTo(peer) {
  await populatePeers();
  showView("send");
  const sel = $("#send-to");
  if (![...sel.options].some(o => o.value === peer)) {
    const opt = document.createElement("option");
    opt.value = peer; opt.textContent = peer;
    sel.insertBefore(opt, sel.firstChild);
  }
  sel.value = peer;
  $("#send-kind").value = "answer";
  $("#send-content").focus();
  setStatus(`replying to ${peer}`, "ok");
}

// ---------- highlights ----------
const CATEGORIES = [
  { key: "PRs",      label: "Pull Requests", test: (m) => /\bPR[\s#:_-]*\d+|\/pull\/\d+|\bnew PR\b|pull request/i.test(m.content) },
  { key: "Seeds",    label: "Seeds",         test: (m) => /\bkind=seed\b|seed_id\b|\bseed:\s/i.test(m.content) },
  { key: "UNBLOCKs", label: "UNBLOCKs",      test: (m) => /\bUNBLOCK(S|ED|ING)?\b/.test(m.content) || m.kind === "unblock" },
  { key: "Triage",   label: "Triage",        test: (m) => /\btriage\b/i.test(m.content) },
  { key: "AI²",      label: "AI²",           test: (m) => /\bAI[²2]\b|\bAI\^2\b/i.test(m.content) },
];

async function refreshHighlights() {
  try {
    setStatus("loading 48h…");
    // /messages doesn't currently filter by `since`, so pull a generous slice
    // and filter client-side. 500 is plenty for a 48h window on this mesh.
    const { messages } = await apiAll(500);
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const recent = messages.filter(m => {
      const t = Date.parse(m.created_at);
      return !isNaN(t) && t >= cutoff;
    });
    const buckets = new Map(CATEGORIES.map(c => [c.key, []]));
    const other = [];
    for (const m of recent) {
      let placed = false;
      for (const c of CATEGORIES) {
        if (c.test(m)) { buckets.get(c.key).push(m); placed = true; break; }
      }
      if (!placed) other.push(m);
    }
    const tree = $("#highlights-tree");
    tree.innerHTML = "";
    let total = 0;
    for (const c of CATEGORIES) {
      const list = buckets.get(c.key);
      total += list.length;
      if (list.length === 0) continue;
      tree.appendChild(buildCat(c.label, list));
    }
    if (other.length > 0) {
      tree.appendChild(buildCat("Other", other));
    }
    $("#highlights-meta").textContent = `${total + other.length} of ${recent.length} in last 48h · ${new Date().toLocaleTimeString()}`;
    $("#highlights-empty").classList.toggle("hidden", recent.length > 0);
    setStatus("ok", "ok");
  } catch (e) {
    setStatus("err: " + e.message, "err");
  }
}

function buildCat(label, msgs) {
  const det = document.createElement("details");
  det.className = "cat";
  det.open = msgs.length <= 8;
  const sum = document.createElement("summary");
  sum.innerHTML = `<span>${label}</span><span class="cat-count">${msgs.length}</span>`;
  det.appendChild(sum);
  const list = document.createElement("ul");
  list.className = "msg-list cat-list";
  det.appendChild(list);
  renderMessages(list, msgs);
  return det;
}

// ---------- settings ----------
function populateSettings() {
  $("#cfg-base").value = state.base;
  $("#cfg-token").value = state.token;
  $("#cfg-poll").value = String(state.pollSec);
}

function saveSettings(ev) {
  ev.preventDefault();
  state.base = $("#cfg-base").value.replace(/\s+/g, "").replace(/\/$/, "");
  state.token = $("#cfg-token").value.replace(/\s+/g, "");
  state.pollSec = Math.max(10, Math.min(600, parseInt($("#cfg-poll").value, 10) || 30));
  localStorage.setItem(LS.base, state.base);
  localStorage.setItem(LS.token, state.token);
  localStorage.setItem(LS.poll, String(state.pollSec));
  $("#cfg-result").textContent = "saved · restarting poll loop";
  startPollLoop();
  // re-fetch peers next time Send is opened
  $("#send-to").innerHTML = "";
}

async function testConnection() {
  $("#cfg-result").textContent = "testing…";
  // apply current form values without persisting
  const prev = { base: state.base, token: state.token };
  state.base = $("#cfg-base").value.replace(/\s+/g, "").replace(/\/$/, "");
  state.token = $("#cfg-token").value.replace(/\s+/g, "");
  try {
    const { peers } = await apiPeers();
    $("#cfg-result").textContent = `✓ ok — ${peers.length} peers (${peers.map(p => p.name).join(", ")})`;
  } catch (e) {
    $("#cfg-result").textContent = "✗ " + e.message;
    state.base = prev.base; state.token = prev.token;
  }
}

// ---------- poll loop ----------
function startPollLoop() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (!state.token) return;
  refreshInbox();
  state.pollTimer = setInterval(() => {
    if ($("#view-inbox").classList.contains("active")) refreshInbox();
  }, state.pollSec * 1000);
}

// ---------- wire ----------
window.addEventListener("DOMContentLoaded", async () => {
  $$(".tab").forEach(t => t.addEventListener("click", () => showView(t.dataset.view)));
  $("#refresh-inbox").addEventListener("click", refreshInbox);
  $("#refresh-highlights").addEventListener("click", refreshHighlights);
  $("#refresh-services").addEventListener("click", refreshServices);
  $("#new-lane-btn").addEventListener("click", () => $("#new-lane-form").classList.toggle("hidden"));
  $("#new-lane-form").addEventListener("submit", createLaneFromForm);
  $("#send-form").addEventListener("submit", handleSend);
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#cfg-test").addEventListener("click", testConnection);

  // Prefer a Meta-Edge SSO session; fall back to a manually-pasted token.
  if (!state.token) await trySsoBoot();
  if (!state.token) {
    showView("settings");
    setStatus("sign in or paste a token — Settings", "err");
  } else {
    showView("inbox");
    startPollLoop();
  }
  renderAuthState();   // reflect SSO connected-state in Settings

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* HTTPS-only on some browsers */ });
  }
});
