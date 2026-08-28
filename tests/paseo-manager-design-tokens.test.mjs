import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function ui() {
  return readFile(new URL("../web/paseo-manager.js", import.meta.url), "utf8");
}

test("the console styles itself from one token set instead of per-layer literals", async () => {
  const source = await ui();

  assert.match(source, /:root\{[\s\S]*?--pm-s1:/u, "the token block is missing");
  for (const token of [
    "--pm-s0", "--pm-s1", "--pm-s2", "--pm-s3", "--pm-s4",
    "--pm-line", "--pm-line-strong",
    "--pm-text", "--pm-dim", "--pm-faint",
    "--pm-accent", "--pm-accent-hi", "--pm-accent-soft", "--pm-accent-ink",
    "--pm-ok", "--pm-danger",
    "--pm-r-xs", "--pm-r-sm", "--pm-r-md", "--pm-r-lg", "--pm-r-pill",
    "--pm-tap", "--pm-tap-sm",
  ]) {
    assert.ok(source.includes(token + ":"), `token ${token} is not defined`);
  }

  // The drawer and its two sticky bars have to share one surface token or a seam shows
  // through the header while the panel scrolls.
  assert.match(source, /#pm-drawer\{background:var\(--pm-s1\)/u);
  assert.match(source, /#pm-head\{background:var\(--pm-s1\)/u);
});

test("primary and danger buttons outrank the neutral .pm-actions rule", async () => {
  const source = await ui();

  // `.pm-actions button` is (0,1,1) and beats a bare `.pm-primary` at (0,1,0), which is
  // why every confirm button in the console rendered the same grey as cancel. The
  // compound selector is what makes the accent actually apply.
  assert.match(
    source,
    /\.pm-primary,\.pm-actions button\.pm-primary\{background:var\(--pm-accent\)/u,
  );
  assert.match(
    source,
    /\.pm-danger,\.pm-actions button\.pm-danger\{color:var\(--pm-danger\)/u,
  );
});

test("the console keeps one visible focus ring and no orange accent", async () => {
  const source = await ui();

  assert.match(source, /#pm-drawer :focus-visible[^{]*\{outline:2px solid var\(--pm-accent-hi\)/u);
  // .pm-supplier-row ships `outline:none`, so it needs its own inset replacement.
  assert.match(source, /\.pm-supplier-row:focus-visible\{outline:2px solid var\(--pm-accent-hi\);outline-offset:-2px/u);
  // Fields need the #pm-drawer prefix or the generic ID rule above adds a second ring.
  assert.match(source, /#pm-drawer \.pm-input:focus-visible\{outline:none/u);

  // The add button was #f28a25 with white text: 2.49:1, under the 4.5:1 AA floor, and the
  // only non-green accent in the console. Match declarations, not the comment that
  // records why it went away.
  assert.doesNotMatch(source, /(?:background|color|box-shadow)[^;"]*#f28a25/u);
  assert.match(source, /\.pm-add-action\{[^}]*background:var\(--pm-accent\)/u);
});

test("the wide layout fits every tab on one row", async () => {
  const source = await ui();

  // PRIMARY_TABS has seven entries; an earlier layer pinned the wide grid to six columns,
  // which wrapped the last tab onto a row of its own.
  const tabCount = (source.match(/var PRIMARY_TABS = \[(.*?)\];/u)?.[1].match(/\[\s*"/gu) ?? []).length;
  assert.equal(tabCount, 7, "PRIMARY_TABS changed; re-check the wide tab strip");
  assert.match(
    source,
    /@media\(min-width:700px\)\{[\s\S]*?#pm-tabs\{display:flex\}#pm-tabs button\{flex:1 1 0/u,
  );
});
