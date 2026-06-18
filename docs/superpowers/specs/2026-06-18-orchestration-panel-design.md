# Orchestration Config Panel — Design (v1)

**Goal:** Add an "Automations" tab to the meta-edge-surfer PWA that lets the
commander see the swarph's scheduled events and pause/resume each — a human face
on the automation control plane, on the same app he already gets mesh DMs.

**Status:** design approved 2026-06-18 (commander "perfect lets roll").
**Home:** `meta-edge-surfer` (the existing commander-facing mesh-DM PWA, lab-ovh
`:8089`). Companion to the automation control plane
([[project_swarph_orchestration_shipped]]; spec
`research/architecture/swarph_automation_control_plane_spec.md`).

---

## 1. Architecture

A **4th tab** ("Automations") in the existing vanilla SPA (`index.html` + `app.js`
+ `styles.css`), alongside Inbox / Send / Highlights / Settings. It reuses the
existing `api(path, opts)` helper — **browser → gateway `:8788`, operator bearer
token already in `localStorage`** (the Settings tab). 

**Zero backend / gateway / orchestrator changes.** The `/scheduled-events`
endpoints already exist and the commander's token is operator, so the panel is
**pure frontend** — no proxy, no new mutation, no `serve.py` change (it stays a
static file server), no service-worker/manifest change.

## 2. What it shows

`GET /scheduled-events` → a card per event:
- **name** (e.g. `weekly-newsletter`)
- **trigger** — for `time`: the cron expr, humanized where easy (e.g.
  `0 14 * * 0` → "Sun 14:00 UTC"), else the raw expr; for `event`: the predicate
  kind (e.g. `on_channel_post #releases`).
- **target_cell**, **out_channel**
- **enabled** state (clear enabled/disabled visual)
- **last_fired_at** (relative time, "—" if never), **fire_count**, **last_status**

Empty state: "No automations scheduled." Sorted by name.

## 3. Controls (v1 = the genuinely-safe ones)

- ✅ **Per-event enable/disable toggle** → `POST /scheduled-events/{name}/enable`
  or `/disable` → reload the list. Safe + working today.
- ❌ **Fire-now — OMITTED from v1 (deliberate).** The gateway's `fire-now` is the
  *mark-not-wake* interim: it advances `last_fired_at` (suppressing the next cron
  fire) WITHOUT actually waking, until the event-trigger follow-up's
  fire-now-actually-wakes lands. A "Fire now" button today would let the commander
  *skip* the next scheduled fire (e.g. skip Sunday's newsletter) thinking he ran
  it — a footgun. Held until the live-wake mechanism exists.
- ❌ **Master arm/disarm (`SCHEDULER_ENABLED`) — DEFERRED.** It's an orchestrator
  env var, not a gateway field; flipping/showing it live needs a gateway
  runtime-flag the orchestrator reads each tick (a future increment + drop seat-A).
  v1 omits it; the global arm stays a CLI flip. A static note in the tab says so.

## 4. Error / empty / auth handling

- Reuses the existing `api()` non-2xx throw → the existing status-bar error
  display ("open Settings" if no token, etc.).
- No token configured → the same "no token — open Settings" path the other tabs use.
- The commander's token is operator → `GET /scheduled-events` returns all events
  (operators read all; per-peer read-scope is a non-issue for the operator panel).

## 5. Testing

A **Playwright visual + console smoke** (the swarph-ai-site pattern, run
controller-side): serve the PWA, open the Automations tab against the live gateway,
assert (a) the `weekly-newsletter` card renders with its cron + enabled state, (b)
the enable/disable toggle round-trips (disable → reload shows disabled → re-enable),
(c) zero console errors. No unit tests — it's a frontend tab over a live API; the
smoke is the gate.

## 6. File structure

- **Modify `index.html`** — add the "Automations" tab button + a
  `<section id="view-automations">` container (mirror the existing tab markup).
- **Modify `app.js`** — `loadAutomations()` (fetch + render), `renderAutomations()`
  (the cards), `toggleEvent(name, enabled)` (enable/disable), the tab-switch wiring,
  a tiny `humanizeCron()` for the common cases. Follow the existing view/poll pattern.
- **Modify `styles.css`** — `.automation-card` + toggle styles matching the PWA aesthetic.

## 7. Deferred (named, not built)

fire-now (until fire-now-actually-wakes); the live master arm/disarm switch (until
the gateway runtime-flag); the create-automation form (v2 — cron builder + target
picker + context_ref anchors); richer event-trigger displays. Each its own later
increment.
