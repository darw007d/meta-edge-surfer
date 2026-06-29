// Unit test for renderOperatorTabs() in app.js.
// Operator-only tabs (Automations, Services) hit control-plane endpoints that 403
// for a member server-side — they must be HIDDEN for a non-admin session and
// SHOWN for an admin. Purely UX (gateway is the real gate), but a regressed hide
// would surface controls a member can only get 403s from.
//
// Run: node test_operator_tabs.mjs   (exit 0 = pass)
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function extract(name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found`);
  const open = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

// Returns {hidden: {automations, services}, switchedToInbox} after render.
function run({ ssoActive, ssoRole, activeView }) {
  const tabs = {
    automations: { dataset: { view: "automations" }, _hidden: false, classList: { toggle(c, f) { if (c === "hidden") this._owner._hidden = f; } } },
    services: { dataset: { view: "services" }, _hidden: false, classList: { toggle(c, f) { if (c === "hidden") this._owner._hidden = f; } } },
  };
  tabs.automations.classList._owner = tabs.automations;
  tabs.services.classList._owner = tabs.services;
  const activeTab = activeView ? { dataset: { view: activeView } } : null;
  let switchedTo = null;
  const ctx = {
    ssoActive,
    state: { ssoRole },
    showView: (v) => { switchedTo = v; },
    document: {
      querySelector: (sel) => {
        if (sel.includes('data-view="automations"')) return tabs.automations;
        if (sel.includes('data-view="services"')) return tabs.services;
        if (sel === ".tab.active") return activeTab;
        return null;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`const OPERATOR_TABS=["automations","services"];\n${extract("renderOperatorTabs")}\nrenderOperatorTabs();`, ctx);
  return {
    automationsHidden: tabs.automations._hidden,
    servicesHidden: tabs.services._hidden,
    switchedTo,
  };
}

// 1. Member session → both operator tabs hidden.
let r = run({ ssoActive: true, ssoRole: "member", activeView: "inbox" });
assert.equal(r.automationsHidden, true, "member: Automations hidden");
assert.equal(r.servicesHidden, true, "member: Services hidden");

// 2. Admin session → both shown.
r = run({ ssoActive: true, ssoRole: "admin", activeView: "inbox" });
assert.equal(r.automationsHidden, false, "admin: Automations shown");
assert.equal(r.servicesHidden, false, "admin: Services shown");

// 3. Not signed in → hidden (no operator surfaces for an anon session).
r = run({ ssoActive: false, ssoRole: undefined, activeView: "inbox" });
assert.equal(r.automationsHidden, true, "anon: Automations hidden");

// 4. Member stranded on a hidden view → bounced to Inbox.
r = run({ ssoActive: true, ssoRole: "member", activeView: "services" });
assert.equal(r.switchedTo, "inbox", "member on a hidden tab → switched to inbox");

// 5. Admin on an operator view → NOT bounced.
r = run({ ssoActive: true, ssoRole: "admin", activeView: "services" });
assert.equal(r.switchedTo, null, "admin stays on the operator tab");

console.log("renderOperatorTabs() tests: 5 passed");
