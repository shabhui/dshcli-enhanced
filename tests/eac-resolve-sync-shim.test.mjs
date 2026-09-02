// Call shapes captured from a real `dsh web` boot on Android (Node 24.18.0),
// by instrumenting ModuleLoader.prototype.resolveSync. Both shapes below
// occurred in the same process: 1 entry-module v2 call, 158 v1 calls.
import assert from "node:assert/strict";
import test from "node:test";

import { planResolveSyncCall } from "../scripts/eac-android-overlay/resolve-sync-plan.mjs";

test("v1 call from dsh-client-modules is translated to the v2 shape", () => {
  // Observed: locatePkgJson(spec, baseUrl, {}) — dsh-client-modules/lib/index.js:682
  const plan = planResolveSyncCall(
    "@deepseek-ai/dsh-llm",
    "file:///data/user/0/com.dshcli/files/home/.dsh/profiles/web-desktop/",
    {},
  );
  assert.equal(plan.translated, true);
  assert.equal(plan.parentURL, "file:///data/user/0/com.dshcli/files/home/.dsh/profiles/web-desktop/");
  assert.equal(plan.request.specifier, "@deepseek-ai/dsh-llm");
  assert.deepEqual(plan.request.attributes, {});
});

test("the entry-module v2 call passes through untouched", () => {
  // Observed exactly once per boot, the very first resolution:
  //   arg1 = undefined, arg2 = { specifier: URL, phase, attributes }, arg3 = undefined
  // Regression guard: a discriminator keyed on `typeof specifier === "string"`
  // misreads this as v1 and puts the request object into parentURL, which is
  // ERR_INVALID_ARG_TYPE and kills `dsh web` at startup (exit 1).
  const request = {
    __proto__: null,
    specifier: new URL("file:///data/user/0/com.dshcli/files/home/.paseo-app/runtime/eac/dsh-desktop/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    phase: "evaluation",
    attributes: { __proto__: null },
  };
  const plan = planResolveSyncCall(undefined, request, undefined);
  assert.equal(plan.translated, false);
  assert.equal(plan.parentURL, undefined);
  assert.equal(plan.request, request, "the request object must be forwarded by identity");
});

test("ordinary v2 calls with a string specifier pass through untouched", () => {
  const request = { __proto__: null, specifier: "node:fs", attributes: { __proto__: null }, phase: "evaluation" };
  const parent = "file:///data/user/0/com.dshcli/files/home/.paseo-app/runtime/eac/dsh-desktop/node_modules/";
  const plan = planResolveSyncCall(parent, request, undefined);
  assert.equal(plan.translated, false);
  assert.equal(plan.parentURL, parent);
  assert.equal(plan.request, request);
});

test("a v1 call with no attributes argument still yields a usable request", () => {
  const plan = planResolveSyncCall("picturereader", "file:///profiles/web-desktop/", undefined);
  assert.equal(plan.translated, true);
  assert.equal(plan.request.specifier, "picturereader");
  assert.equal(plan.request.attributes, undefined);
});

test("a non-string v1 specifier is stringified rather than forwarded raw", () => {
  const plan = planResolveSyncCall(
    new URL("file:///pkg/index.js"),
    "file:///profiles/web-desktop/",
    {},
  );
  assert.equal(plan.translated, true);
  assert.equal(typeof plan.request.specifier, "string");
  assert.equal(plan.request.specifier, "file:///pkg/index.js");
});
