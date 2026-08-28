import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bundled Paseo session keeps image and attachment message support", async () => {
  const [installer, session] = await Promise.all([
    readFile(new URL("../install.mjs", import.meta.url), "utf8"),
    readFile(new URL("../patches/server/session.js", import.meta.url), "utf8"),
  ]);

  assert.match(installer, /\["session\.js", "session\.js"\]/);
  assert.match(session, /buildAgentPrompt\(promptText, images, attachments\)/);
  assert.match(session, /imageCount:\s*images\?\.length/);
  assert.match(session, /attachmentCount:\s*attachments\?\.length/);
  assert.match(session, /case "file\.upload\.request"/);
});
