import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("Android startup provides every Agent a concrete mobile environment prompt", async () => {
  const [startup, bootstrap, installer] = await Promise.all([
    source("ZeroTermux-main/app/src/main/assets/paseo-runtime/start-paseo.sh"),
    source("patches/server/bootstrap.js"),
    source("install.mjs"),
  ]);

  assert.match(startup, /PASEO_BASE_SYSTEM_PROMPT_FILE/u);
  assert.match(startup, /Android application sandbox/u);
  assert.match(startup, /com\.paseoe/u);
  assert.match(startup, /Do not assume Windows, macOS, desktop Linux/u);
  assert.match(startup, /Commands confirmed present: \$DETECTED_COMMANDS/u);
  assert.match(bootstrap, /baseSystemPrompt/u);
  assert.match(bootstrap, /appendSystemPrompt/u);
  assert.match(
    bootstrap,
    /new AgentManager\(\{[\s\S]*?appendSystemPrompt:\s*combineAgentSystemPrompt\(baseSystemPrompt,\s*config\.appendSystemPrompt\)/u,
  );
  assert.match(installer, /prependACPSystemPrompt/u);
  assert.match(installer, /daemonAppendSystemPrompt/u);
});

test("the environment prompt reports what the device actually has, not a fixed list", async () => {
  const startup = await source(
    "ZeroTermux-main/app/src/main/assets/paseo-runtime/start-paseo.sh",
  );

  // The probe has to run before the prompt is written, or it reports nothing.
  const probeIndex = startup.indexOf("detect_commands\n");
  const promptIndex = startup.indexOf("<<PASEO_AGENT_ENVIRONMENT_FACTS");
  assert.ok(probeIndex > 0, "detect_commands is never called");
  assert.ok(promptIndex > 0, "the environment facts heredoc is missing");
  assert.ok(probeIndex < promptIndex, "detect_commands must run before the prompt is written");

  assert.match(startup, /command -v "\$candidate"/u);
  assert.match(startup, /DETECTED_COMMANDS="\$\{detected# \}"/u);
  assert.match(startup, /MISSING_COMMANDS="\$\{missing# \}"/u);
  assert.match(startup, /Confirmed absent right now: \$MISSING_COMMANDS/u);

  // Device facts have to be interpolated, so the facts heredoc must stay unquoted while
  // the rules heredoc stays quoted (its backticks and $ are literal prose).
  assert.match(startup, /<<PASEO_AGENT_ENVIRONMENT_FACTS\n/u);
  assert.match(startup, /<<'PASEO_AGENT_ENVIRONMENT'\n/u);
  assert.match(startup, /uname -m/u);
  assert.match(startup, /getprop ro\.build\.version\.release/u);
  assert.match(startup, /getprop ro\.build\.version\.sdk/u);
  assert.match(startup, /- HOME=\$HOME/u);
  assert.match(startup, /- PATH=\$PATH/u);

  // A hardcoded inventory is exactly what the probe replaced; it goes stale silently.
  assert.doesNotMatch(startup, /Baseline shell tools include/u);
});

test("the console can show the built-in environment prompt it appends to", async () => {
  const [bootstrap, management, ui] = await Promise.all([
    source("patches/server/bootstrap.js"),
    source("patches/server/paseo-management.js"),
    source("web/paseo-manager.js"),
  ]);

  assert.match(bootstrap, /setRuntime\(\{[\s\S]*?baseSystemPrompt,/u);
  assert.match(
    management,
    /action === "global-settings"[\s\S]*?baseSystemPrompt:\s*typeof activeRuntime\.baseSystemPrompt === "string"/u,
  );

  // Rendered read-only, and only ever populated from the daemon: a hardcoded copy in the
  // UI would drift from whatever the device actually probed.
  assert.match(ui, /id="pm-base-system-prompt-block"/u);
  assert.match(ui, /<pre id="pm-base-system-prompt"/u);
  assert.match(
    ui,
    /loadGlobalSettings[\s\S]*?data\.baseSystemPrompt === "string" \? data\.baseSystemPrompt\.trim\(\)/u,
  );
  // The append-not-replace relationship is the whole point of showing it.
  assert.match(ui, /追加在它之后，不会替换它/u);
});

test("standalone Web UI derives its daemon endpoint from the selected origin port", async () => {
  const [standalone, installer] = await Promise.all([
    source("web/paseo-standalone-bootstrap.js"),
    source("install.mjs"),
  ]);

  assert.match(standalone, /window\.location\.host/u);
  assert.match(standalone, /listen:\s*LOCAL_ENDPOINT/u);
  assert.match(standalone, /endpoint:\s*LOCAL_ENDPOINT/u);
  assert.doesNotMatch(standalone, /127\.0\.0\.1:6767/u);
  assert.match(installer, /window\.location\.host/u);
});
