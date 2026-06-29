// Unit test for wireInviteIntoSignIn() in app.js — F-new-3 fix.
// A brand-new (not-yet-allowlisted) invitee is authorized by the invite itself, so
// the invite must ride THROUGH the SSO start (the issuer claims it inline on the
// callback) — otherwise the un-allowlisted login 403s before any client claim runs.
// This guards that the sign-in buttons get the invite appended as ?h=<handle> for
// an opaque handle (F7) and ?invite=<jwt> for a legacy raw-JWT value.
//
// Run: node test_invite_wire.mjs   (exit 0 = pass)
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const start = src.indexOf("function wireInviteIntoSignIn(");
assert.ok(start >= 0, "wireInviteIntoSignIn() not found in app.js");
const open = src.indexOf("{", start);
let depth = 0, end = -1;
for (let i = open; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
assert.ok(end > open, "could not brace-match wireInviteIntoSignIn()");
const fnSrc = src.slice(start, end);

// Fake three sign-in anchors; return their resulting hrefs after wiring `val`.
function wireAndGetHrefs(val) {
  const anchors = ["/auth/github/start", "/auth/google/start", "/auth/microsoft/start"]
    .map((href) => ({
      _href: href,
      getAttribute() { return this._href; },
      setAttribute(_k, v) { this._href = v; },
    }));
  const ctx = {
    document: { querySelectorAll: (sel) => (sel === "a.btn-sso" ? anchors : []) },
    encodeURIComponent,
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc + "\nglobalThis.__wired = wireInviteIntoSignIn(" + JSON.stringify(val) + ");", ctx);
  return { wired: ctx.__wired, hrefs: anchors.map((a) => a._href) };
}

// 1. An opaque handle (no dots) -> ?h=<handle> on every sign-in button.
const handle = "Xk7Qz9_opaque-handle-no-dots";
let r = wireAndGetHrefs(handle);
assert.equal(r.wired, true, "wiring a handle should report wired=true");
for (const href of r.hrefs) {
  assert.ok(href.includes(`?h=${handle}`), `handle should be appended as ?h=: ${href}`);
  assert.ok(!href.includes("invite="), `no JWT param for a handle: ${href}`);
}

// 2. A legacy raw JWT (two dots) -> ?invite=<jwt> (compat path still honored).
const jwt = "aaa.bbb.ccc";
r = wireAndGetHrefs(jwt);
for (const href of r.hrefs) {
  assert.ok(href.includes("?invite=aaa.bbb.ccc"), `legacy JWT should be ?invite=: ${href}`);
  assert.ok(!href.includes("?h="), `a JWT must not be sent as a handle: ${href}`);
}

// 3. Wiring is idempotent on the base (no ?a=1?b=2 doubling if called twice).
r = wireAndGetHrefs(handle);
const again = (() => {
  // simulate a second wire over the already-wired href by re-splitting on "?"
  const a = { _href: r.hrefs[0], getAttribute() { return this._href; }, setAttribute(_k, v) { this._href = v; } };
  const ctx = { document: { querySelectorAll: () => [a] }, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(fnSrc + `\nwireInviteIntoSignIn(${JSON.stringify(handle)});`, ctx);
  return a._href;
})();
assert.equal((again.match(/\?/g) || []).length, 1, `exactly one query separator: ${again}`);

console.log("wireInviteIntoSignIn() tests: 4 passed");
