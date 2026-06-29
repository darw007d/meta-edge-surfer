// Unit test for renderInviteUi() in app.js — invite-flow Task 5 (PWA) follow-up.
// Security invariant INV3 (admin-only mint), UX side: the "Invite a member"
// control is shown ONLY for an admin SSO session. A member SSO session and an
// unauthenticated session MUST NOT see the control. (Server still re-checks admin
// on every POST /auth/invite, so this is a UX hide — but a regressed hide would
// surface the form to non-admins, an adversarial-confusion footgun.)
//
// Run: node test_invite_ui.mjs   (exit 0 = pass)
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const start = src.indexOf("function renderInviteUi()");
assert.ok(start >= 0, "renderInviteUi() function not found in app.js");
const open = src.indexOf("{", start);
let depth = 0, end = -1;
for (let i = open; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
assert.ok(end > open, "could not brace-match renderInviteUi()");
const fnSrc = src.slice(start, end);

// Returns whether #admin-invite ends up hidden (true) or visible (false).
function evalHidden({ ssoActive, ssoRole }) {
  let hidden = null;   // capture the last classList.toggle("hidden", force)
  const admEl = {
    classList: {
      toggle(cls, force) { if (cls === "hidden") hidden = !!force; },
    },
  };
  const ctx = {
    ssoActive,
    state: { ssoRole },
    $: (sel) => (sel === "#admin-invite" ? admEl : null),
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc + "\nrenderInviteUi();", ctx);
  return hidden;
}

// 1. Admin SSO session -> control VISIBLE (not hidden).
assert.equal(evalHidden({ ssoActive: true, ssoRole: "admin" }), false,
  "an admin SSO session must SEE the Invite control");

// 2. Member SSO session -> control HIDDEN (no self-escalation surface).
assert.equal(evalHidden({ ssoActive: true, ssoRole: "member" }), true,
  "a member SSO session must NOT see the Invite control");

// 3. Unauthenticated (no SSO) even if a stale role leaked -> HIDDEN.
assert.equal(evalHidden({ ssoActive: false, ssoRole: "admin" }), true,
  "an unauthenticated session must NOT see the Invite control");

// 4. SSO active but role unset/undefined -> HIDDEN (fail-closed default).
assert.equal(evalHidden({ ssoActive: true, ssoRole: undefined }), true,
  "an SSO session with no admin role must default to hidden");

console.log("renderInviteUi() tests: 4 passed");
