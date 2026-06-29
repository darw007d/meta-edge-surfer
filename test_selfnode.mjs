// Unit test for selfNode() in app.js — fractal-membership Task 7 follow-up.
// The verify flagged: selfNode() falls back to the "commander" LITERAL when an
// SSO session is active but the member has no provisioned node (issuer /auth/me
// returned no node). The plan §Task 7 requires from_node = state.ssoNode in SSO
// mode "never the commander literal". Legacy manual/shared-token mode MUST keep
// the "commander" fallback (byte-identical for the commander's shared-token use).
//
// Run: node test_selfnode.mjs   (exit 0 = pass)
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const start = src.indexOf("function selfNode()");
assert.ok(start >= 0, "selfNode() function not found in app.js");
// Extract the function by balanced-brace matching from its opening "{".
const open = src.indexOf("{", start);
let depth = 0, end = -1;
for (let i = open; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
assert.ok(end > open, "could not brace-match selfNode()");
const fnSrc = src.slice(start, end);

function evalSelfNode({ ssoActive, ssoNode }) {
  const ctx = { COMMANDER: "commander", ssoActive, state: { ssoNode } };
  vm.createContext(ctx);
  vm.runInContext(fnSrc + "\nthis.__r = selfNode();", ctx);
  return ctx.__r;
}

// 1. SSO active + provisioned node -> the member's own node.
assert.equal(evalSelfNode({ ssoActive: true, ssoNode: "claire-mbp#0001" }), "claire-mbp#0001");

// 2. SSO active + NO node (under-provisioned member) -> NOT the commander literal.
const underProvisioned = evalSelfNode({ ssoActive: true, ssoNode: "" });
assert.notEqual(underProvisioned, "commander",
  "SSO mode must never fall back to the 'commander' literal");
assert.ok(!underProvisioned, "under-provisioned SSO node should be falsy (empty), got: " + underProvisioned);

// 3. Legacy manual / shared-token mode (not SSO) + no node -> "commander" (byte-identical).
assert.equal(evalSelfNode({ ssoActive: false, ssoNode: "" }), "commander",
  "manual/shared-token mode must keep the legacy 'commander' fallback");
assert.equal(evalSelfNode({ ssoActive: false, ssoNode: undefined }), "commander");

console.log("selfNode() tests: 4 passed");
