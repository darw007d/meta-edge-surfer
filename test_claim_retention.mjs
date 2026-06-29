// Unit test for the pending-invite retention rule in app.js — invite-flow Task 5
// (PWA) adversarial follow-up. Security/robustness invariant INV6 (fail-closed,
// no claim loop) UX side: claimPendingInvite() must DROP a pending invite on a
// terminal 4xx (used/expired/wrong account) so a dead link doesn't loop, but
// KEEP it on a transient 5xx (gateway hiccup) so the single-use jti — still
// UNCONSUMED server-side on a 5xx — can be redeemed on the next boot.
//
// Regression guard: ssoClaimInvite() throws `new Error(j.detail || status)`, so a
// 502 that carries a `detail` body (e.g. "could not provision membership; try
// again") used to defeat a /^5\d\d/.test(e.message) retention check and DROP the
// invite. The status is now carried on err.status; this test breaks if that
// regresses.
//
// Run: node test_claim_retention.mjs   (exit 0 = pass)
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function extract(name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found in app.js`);
  if (src.slice(start - 6, start) === "async ") start -= 6;   // keep the async keyword
  const open = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > open, `could not brace-match ${name}()`);
  return src.slice(start, end);
}

// Both functions are declared with the `async function NAME(` form.
const claimSrc = extract("ssoClaimInvite");
const handlerSrc = extract("claimPendingInvite");

// Run claimPendingInvite() against a fake fetch returning {status, detail|body}.
// Returns whether the pending invite SURVIVED (true) or was dropped (false).
async function runClaim({ status, detail, node }) {
  let stored = "the-invite-jti";
  const ls = {
    getItem: (k) => (k === "pendingInvite" ? stored : null),
    setItem: () => {},
    removeItem: (k) => { if (k === "pendingInvite") stored = null; },
  };
  const ok = status >= 200 && status < 300;
  const ctx = {
    fetch: async () => ({
      ok,
      status,
      json: async () => (ok ? { claimed: true, node, role: "member", cells: [] }
                            : (detail !== undefined ? { detail } : {})),
    }),
    localStorage: ls,
    LS: { pendingInvite: "pendingInvite" },
    ssoActive: true,
    state: { ssoNode: "old", ssoRole: "member" },
    setStatus: () => {},
    encodeURIComponent,
    console: { log() {}, error() {} },
  };
  vm.createContext(ctx);
  // Define both functions in the same context (claimPendingInvite calls ssoClaimInvite).
  vm.runInContext(`${claimSrc}\n${handlerSrc}\nglobalThis.__run = claimPendingInvite;`, ctx);
  await ctx.__run();
  return stored !== null;   // true => invite KEPT
}

// 1. Success (200) -> consumed -> dropped.
assert.equal(await runClaim({ status: 200, node: "n1" }), false,
  "a successful claim must clear the pending invite");

// 2. Terminal 4xx with a detail body (used/expired/wrong account) -> dropped.
assert.equal(await runClaim({ status: 409, detail: "invite already consumed" }), false,
  "a 4xx claim must drop the pending invite (no loop)");

assert.equal(await runClaim({ status: 403, detail: "this invite is bound to another account" }), false,
  "a wrong-account 4xx must drop the pending invite");

// 3. THE REGRESSION: a transient 5xx that CARRIES a detail body must be KEPT.
//    Previously /^5\d\d/.test("could not provision…") was false -> wrongly dropped.
assert.equal(await runClaim({ status: 502, detail: "could not provision membership; try again" }), true,
  "a 502 with a detail body must KEEP the pending invite for the next boot");

// 4. A bare 5xx (no detail body) must also be kept (control).
assert.equal(await runClaim({ status: 503 }), true,
  "a bare 5xx must keep the pending invite");

console.log("claimPendingInvite() retention tests: 5 passed");
