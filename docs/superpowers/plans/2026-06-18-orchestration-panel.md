# Orchestration Config Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Automations" tab to the meta-edge-surfer PWA that lists the swarph's scheduled events and lets the commander enable/disable each — a human face on the automation control plane.

**Architecture:** A 4th view in the existing vanilla SPA (`index.html` + `app.js` + `styles.css`), mirroring the Inbox/Send/Highlights pattern. Uses the existing `api(path, opts)` helper (browser → gateway `:8788`, operator bearer token from `localStorage`). Pure frontend — the `/scheduled-events` + `/{name}/enable|disable` endpoints already exist; zero backend/gateway/orchestrator changes, no `serve.py`/service-worker change.

**Tech Stack:** Vanilla JS SPA (no framework, no build step), `<template>`-clone rendering, the existing `api()`/`showView()`/`setStatus()` helpers. Verification = a Playwright visual+console smoke (controller-side, the swarph-ai-site precedent) — there is no JS unit-test harness in this PWA and adding one is out of scope (YAGNI); structural assertions + the smoke are the gate.

**Spec:** `docs/superpowers/specs/2026-06-18-orchestration-panel-design.md`.

**Repo:** `/home/ubuntu/meta-edge-surfer` (git). Served by `serve.py` on `:8089`. Deploy = the running `meta-edge-surfer.service` serves the static files in place; a restart is NOT needed for static-file changes (the browser fetches the new files), but a hard-refresh / SW update may be (see Task 4). Branch + PR if the repo has a remote; otherwise commit to a branch locally (don't build on the default branch).

---

## File Structure

- **`index.html`** — add the "Automations" tab button, the `#view-automations` section (list container + empty-state + a CLI-managed note), and a `#tpl-automation` `<template>`.
- **`app.js`** — add: two API helpers (`apiSchedEvents`, `apiSchedToggle`), `humanizeCron()`, `renderAutomations()`, `refreshAutomations()`, `toggleEvent()`, and one line in `showView()`.
- **`styles.css`** — `.automation-card` + `.auto-toggle` (+ disabled state) + `.note` styles, matching the PWA aesthetic.
- **Verification** — a controller-side Playwright smoke (no file committed unless the repo has an e2e dir; run via the Playwright MCP tools).

---

## Task 1: Markup — the Automations tab, view, and template

**Files:**
- Modify: `index.html` (the tab bar; the views area; the templates area)

- [ ] **Step 1: Add the tab button**

Find the tab bar (the row of `<button class="tab" data-view="...">` elements — search `data-view="inbox"`). Add, after the Highlights tab and before Settings (match the existing button markup exactly):

```html
<button class="tab" data-view="automations">Automations</button>
```

- [ ] **Step 2: Add the view section**

After the existing `<section id="view-highlights" class="view">…</section>` (search `id="view-highlights"`), add:

```html
<section id="view-automations" class="view">
  <div class="view-head">
    <span id="automations-count" class="count"></span>
  </div>
  <ul id="automations-list" class="msg-list"></ul>
  <p id="automations-empty" class="empty hidden">No automations scheduled.</p>
  <p class="note">Global scheduler arm/disarm (SCHEDULER_ENABLED) is managed via CLI — this panel shows + pauses individual automations.</p>
</section>
```

- [ ] **Step 3: Add the row template**

Next to the existing `<template id="tpl-msg">` (search `tpl-msg`), add:

```html
<template id="tpl-automation">
  <li class="automation-card">
    <div class="auto-row">
      <span class="auto-name"></span>
      <button class="auto-toggle"></button>
    </div>
    <div class="auto-trigger"></div>
    <div class="auto-meta"></div>
  </li>
</template>
```

- [ ] **Step 4: Verify it parses**

Run: `cd /home/ubuntu/meta-edge-surfer && python3 -c "import html.parser,sys; p=html.parser.HTMLParser(); p.feed(open('index.html').read()); print('parsed ok')"`
Expected: `parsed ok` (no exception). Also grep-confirm the three anchors exist:
Run: `grep -c 'data-view="automations"\|id="view-automations"\|id="tpl-automation"' index.html`
Expected: `3`

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/meta-edge-surfer
git add index.html
git commit -m "feat(panel): Automations tab markup — view + template + tab button"
```

---

## Task 2: Logic — API helpers, render, toggle, view wiring

**Files:**
- Modify: `app.js`

- [ ] **Step 1: Add the API helpers**

After the existing `apiSend` definition (search `const apiSend =`), add:

```javascript
const apiSchedEvents = () => api("/scheduled-events");
const apiSchedToggle = (name, enable) =>
  api(`/scheduled-events/${encodeURIComponent(name)}/${enable ? "enable" : "disable"}`,
      { method: "POST" });
```

- [ ] **Step 2: Add `humanizeCron` (common cases only — YAGNI)**

Add near the other tiny helpers (after `fmtTime`):

```javascript
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
```

- [ ] **Step 3: Add `renderAutomations` (mirror `renderMessages`'s template-clone)**

```javascript
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
```

- [ ] **Step 4: Add `refreshAutomations` + `toggleEvent` (mirror `refreshInbox`)**

```javascript
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
```

- [ ] **Step 5: Wire it into `showView`**

In `showView(name)` (search `function showView`), add a line alongside the other per-view refreshes:

```javascript
  if (name === "automations") refreshAutomations();
```

- [ ] **Step 6: Verify the JS is syntactically valid**

Run: `cd /home/ubuntu/meta-edge-surfer && node --check app.js && echo "js ok"`
Expected: `js ok` (no syntax error). (If `node` is absent: `python3 -c "print('skip — node not installed; rely on the Playwright smoke')"`.)

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/meta-edge-surfer
git add app.js
git commit -m "feat(panel): Automations logic — list/render + enable-disable toggle + view wiring"
```

---

## Task 3: Styles — automation cards + toggle

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Add the styles (match the existing token palette — reuse the vars/colors already in styles.css)**

Append to `styles.css` (adjust the color values to the file's existing CSS custom-properties if present — grep `--` in styles.css first and reuse them):

```css
/* ---- Automations tab ---- */
.automation-card { padding: .6rem .75rem; border-bottom: 1px solid var(--border, #2a2a35); }
.automation-card.disabled { opacity: .55; }
.auto-row { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.auto-name { font-weight: 600; }
.auto-trigger { font-size: .85rem; margin-top: .2rem; }
.auto-meta { font-size: .75rem; opacity: .7; margin-top: .15rem; }
.auto-toggle {
  border: 1px solid var(--border, #2a2a35); border-radius: 999px;
  padding: .2rem .7rem; font-size: .75rem; cursor: pointer;
  background: transparent; color: inherit;
}
.auto-toggle.on { background: var(--accent, #3a7); color: #fff; border-color: transparent; }
.note { font-size: .72rem; opacity: .6; padding: .5rem .75rem; }
```

- [ ] **Step 2: Verify CSS has no unbalanced braces**

Run: `cd /home/ubuntu/meta-edge-surfer && python3 -c "s=open('styles.css').read(); assert s.count('{')==s.count('}'), 'unbalanced braces'; print('css ok')"`
Expected: `css ok`

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/meta-edge-surfer
git add styles.css
git commit -m "feat(panel): Automations card + toggle styles"
```

---

## Task 4: Playwright visual + console smoke (the verification gate)

**Files:**
- No committed file — run controller-side via the Playwright MCP tools (the swarph-ai-site precedent).

This is the gate, since the PWA has no JS unit harness. Run against a LOCAL serve to avoid touching the live :8089 (and to inject a test token into localStorage).

- [ ] **Step 1: Serve the PWA locally on a scratch port**

Run (background): `cd /home/ubuntu/meta-edge-surfer && python3 serve.py --bind 127.0.0.1 --port 8099 &`
(Leaves the live :8089 untouched.)

- [ ] **Step 2: Drive the smoke with Playwright (controller-side)**

Using the Playwright MCP tools:
1. `browser_navigate` to `http://127.0.0.1:8099/`.
2. `browser_evaluate` to seed the operator token + base into localStorage so `api()` works, then reload:
   `() => { localStorage.setItem("mes.base", "http://localhost:8788"); localStorage.setItem("mes.token", "<OPERATOR_TOKEN>"); location.reload(); }`
   (Get the operator token from `/home/ubuntu/mesh-gateway/.env` `MESH_GATEWAY_TOKEN` — out-of-band, do NOT paste it into the committed plan/log; the implementer reads it at run time.)
3. `browser_click` the `[data-view="automations"]` tab.
4. `browser_snapshot` / `browser_evaluate` assertions:
   - the `#view-automations` is `.active`;
   - a `.automation-card` exists whose `.auto-name` is `weekly-newsletter`;
   - its `.auto-trigger` contains `Sun 14:00 UTC` (humanizeCron of `0 14 * * 0`);
   - its `.auto-toggle` reads `Enabled`.
5. **Toggle round-trip:** `browser_click` the `weekly-newsletter` `.auto-toggle` → wait → assert it now reads `Disabled` + the card has `.disabled`; click again → assert back to `Enabled`. (This mutates the LIVE event's enabled flag via the gateway; it ends re-enabled, so the Sunday fire is preserved — verify the final state is Enabled.)
6. `browser_console_messages` → assert **zero errors**.

Expected: all assertions pass, console clean, `weekly-newsletter` ends **Enabled**.

- [ ] **Step 3: Stop the scratch serve**

Run: `kill %1 2>/dev/null || true` (the backgrounded local serve from Step 1 — kill by job spec, NOT a `pkill -f` pattern that could self-match).

- [ ] **Step 4: Confirm the live deploy picks it up**

The live `meta-edge-surfer.service` serves the files in place — the changes are live on next browser load. Bump the service-worker cache version if `sw.js` pins asset versions (grep `sw.js` for a `CACHE`/`VERSION` const; if present, increment it so clients fetch the new `app.js`/`index.html`/`styles.css`). Commit that bump with Task 2/3 if needed.

---

## Self-Review

**1. Spec coverage:** §1 architecture → Tasks 1–3 (tab in the SPA, `api()` reuse, zero backend). §2 what-it-shows → Task 2 Step 3 (`renderAutomations` renders name/trigger/target/out_channel/enabled/last_fired/fire_count/last_status). §3 controls → Task 2 (enable/disable toggle); fire-now + master-switch correctly ABSENT (deferred per spec). §4 error/empty/auth → Task 2 Steps 4 (`api()` throw → `setStatus` err; empty-state) + the operator-token reuse. §5 testing → Task 4 (Playwright smoke). §6 file structure → Tasks 1–3. §7 deferred → nothing built for them. ✅ no gaps.

**2. Placeholder scan:** the only `<OPERATOR_TOKEN>` is a deliberate run-time secret the implementer reads OOB from `.env` — explicitly NOT a code placeholder. No TBD/TODO/"handle errors"/vague steps; every code step has complete code.

**3. Type/name consistency:** `apiSchedEvents` returns `{ events }` (matches the gateway `GET /scheduled-events` → `{events, n}`). `apiSchedToggle(name, enable)` hits `/enable|/disable` (matches the gateway endpoints). `renderAutomations(rootList, events)` / `refreshAutomations()` / `toggleEvent(name, currentlyEnabled)` names are consistent across Steps 3–5. `#automations-list` / `#automations-empty` / `#automations-count` / `#tpl-automation` / `#view-automations` / `data-view="automations"` consistent between Task 1 (markup) and Task 2 (logic). Event fields (`name`, `trigger_type`, `cron`, `predicate`, `target_cell`, `out_channel`, `enabled`, `last_fired_at`, `fire_count`, `last_status`) match the `scheduled_events` schema. ✅
