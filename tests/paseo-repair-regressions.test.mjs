import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const management = await readFile(new URL("../patches/server/paseo-management.js", import.meta.url), "utf8");
const proxy = await readFile(new URL("../patches/server/codex-chat-proxy.js", import.meta.url), "utf8");
const androidBuild = await readFile(new URL("../ZeroTermux-main/app/build.gradle", import.meta.url), "utf8");
const androidGradleProperties = await readFile(new URL("../ZeroTermux-main/gradle.properties", import.meta.url), "utf8");

test("explicit conversation import is idempotent for an already imported provider handle", () => {
  const importFunction = management.match(/async function importOneConversation[\s\S]*?\n\}/u)?.[0] || "";
  assert.ok(importFunction, "conversation import function must exist");
  assert.match(importFunction, /agentStorage\.list\(\)/u);
  assert.match(importFunction, /providerHandleId/u);
  assert.match(importFunction, /existing:\s*true/u);
});

test("Codex proxy forwards compact requests instead of returning a permanent unsupported response", () => {
  assert.match(proxy, /async function handleCompaction\(/u);
  assert.match(proxy, /normalizeResponsesCompactEndpoint/u);
  assert.doesNotMatch(proxy, /Standalone remote compaction is disabled/u);
});

test("Android unit-test workers use the Windows code-page encoding for non-ASCII workspaces", () => {
  assert.match(androidGradleProperties, /^org\.gradle\.jvmargs=.*-Dfile\.encoding=GBK/mu);
  assert.match(androidGradleProperties, /^org\.gradle\.jvmargs=.*-Dsun\.jnu\.encoding=GBK/mu);
  assert.doesNotMatch(androidBuild, /tasks\.withType\(Test\)\.configureEach/u);
});

test("Android directory browsing defaults to the app-private home", () => {
  const listDirectories = management.match(/async function listDirectories\([\s\S]*?\n\}/u)?.[0] || "";
  assert.ok(listDirectories, "directory listing function must exist");
  assert.match(listDirectories, /process\.platform\s*===\s*["']android["']/u);
  assert.match(listDirectories, /homedir\(\)/u);
  assert.doesNotMatch(listDirectories, /requestedPath\s*:\s*\?[^;]*\/storage\/emulated\/0/u);
});
