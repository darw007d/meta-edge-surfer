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

const DEFAULT_BASE = `${location.protocol}//${location.hostname}:8788`;
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
function setStatus(text, cls = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = "status " + cls;
}

// ---------- API ----------
async function api(path, opts = {}) {
  if (!state.token) throw new Error("no token configured — open Settings");
  const url = state.base.replace(/\/$/, "") + path;
  const headers = { "Authorization": "Bearer " + state.token, ...(opts.headers || {}) };
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail || ""; } catch {}
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return res.json();
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

// ---------- views ----------
function showView(name) {
  $$(".view").forEach(v => v.classList.toggle("active", v.id === `view-${name}`));
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === name));
  if (name === "inbox") refreshInbox();
  if (name === "send") populatePeers();
  if (name === "highlights") refreshHighlights();
  if (name === "settings") populateSettings();
}

// ---------- inbox ----------
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
    body.textContent = m.content;
    if (state.expanded.has(m.id)) body.classList.add("expanded");
    body.addEventListener("click", () => {
      body.classList.toggle("expanded");
      if (body.classList.contains("expanded")) state.expanded.add(m.id);
      else state.expanded.delete(m.id);
    });
    rootList.appendChild(li);
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
window.addEventListener("DOMContentLoaded", () => {
  $$(".tab").forEach(t => t.addEventListener("click", () => showView(t.dataset.view)));
  $("#refresh-inbox").addEventListener("click", refreshInbox);
  $("#refresh-highlights").addEventListener("click", refreshHighlights);
  $("#send-form").addEventListener("submit", handleSend);
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#cfg-test").addEventListener("click", testConnection);

  if (!state.token) {
    showView("settings");
    setStatus("no token — open Settings", "err");
  } else {
    showView("inbox");
    startPollLoop();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* HTTPS-only on some browsers */ });
  }
});
