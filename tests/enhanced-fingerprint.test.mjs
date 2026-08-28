import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fingerprintDirectory } from "../scripts/enhanced-fingerprint.mjs";

test("enhanced fingerprint is stable across creation order and changes with content", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "paseo-enhanced-first-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "paseo-enhanced-second-"));
  await mkdir(path.join(first, "nested"));
  await mkdir(path.join(second, "nested"));
  await writeFile(path.join(first, "b.txt"), "two");
  await writeFile(path.join(first, "nested", "a.txt"), "one");
  await writeFile(path.join(second, "nested", "a.txt"), "one");
  await writeFile(path.join(second, "b.txt"), "two");

  const firstFingerprint = fingerprintDirectory(first);
  assert.match(firstFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(firstFingerprint, fingerprintDirectory(second));

  await writeFile(path.join(second, "b.txt"), "changed");
  assert.notEqual(firstFingerprint, fingerprintDirectory(second));
});
