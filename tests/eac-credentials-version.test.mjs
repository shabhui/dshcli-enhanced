// EAC 5.3.1 自带的 healCredentialsVersion 把 .credentials.yaml 的 version 写成
// YAML 字符串 "1"，而同一个 deb 里的 dsh-credentials-local 校验的是数字 1
// （lib/index.js:151 `if (fields["version"] !== 1)`）。两者自相矛盾，真机上
// dsh web 因此 100% 起不来：
//
//   Error: credentials-local: .../.credentials.yaml declares version "1";
//          this build reads version 1
//
// 所以不能照抄上游的写死形态，得按【实际会跑的那个校验器】决定写哪一种标量。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// boot-server.js 是 CJS，要 require 这个模块。本仓 package.json 是
// "type": "module"，.js 会被当 ESM（require 也一样，interop 下包类型优先），
// 所以扩展名必须是 .cjs —— 两棵树里都无歧义。
const require = createRequire(import.meta.url);
const { expectedVersionScalar, planCredentialsHeal } = require(
  "../scripts/eac-android-overlay/credentials-version.cjs",
);

// 5.3.1 实际 shipped 的校验行，从设备上原样抄下来。
const NUMBER_VALIDATOR =
  'if (fields["version"] !== 1) throw new Error(`credentials-local: ' +
  "${filename} declares version ${JSON.stringify(fields[\"version\"])}; " +
  'this build reads version 1`);';

const STRING_VALIDATOR =
  'if (fields["version"] !== "1") throw new Error(`credentials-local: ' +
  'declares version ...`);';

test("the shipped 5.3.1 validator is detected as wanting the number", () => {
  assert.equal(expectedVersionScalar(NUMBER_VALIDATOR), "1");
});

test("a build that wants the quoted string is detected too", () => {
  assert.equal(expectedVersionScalar(STRING_VALIDATOR), '"1"');
});

test("an unreadable validator yields null rather than a guess", () => {
  assert.equal(expectedVersionScalar(""), null);
  assert.equal(expectedVersionScalar("something else entirely"), null);
  assert.equal(expectedVersionScalar(null), null);
});

test("the exact device file is healed back to the number form", () => {
  // 这正是真机上被上游 heal 写坏、然后启动失败的那份内容。
  const broken = [
    'version: "1"',
    "records:",
    "  client-connection/browser-session:",
    "    kind: grant",
    "    payload:",
    "      version: 1",
    "      secret: HvIRIxYJM0Z6NzEww4cy10Aru88pjcWQl3qfTm_cP4o",
    "",
  ].join("\n");

  const plan = planCredentialsHeal(broken, "1");
  assert.equal(plan.changed, true);
  assert.match(plan.text, /^version: 1$/m);
  // 嵌套的 payload.version 是别的 schema 的字段，绝不能一起改。
  assert.match(plan.text, /^ {6}version: 1$/m);
  assert.match(plan.text, /secret: HvIRIxYJM0Z6NzEww4cy10Aru88pjcWQl3qfTm_cP4o/);
});

test("a file already in the wanted form is left untouched", () => {
  const good = 'version: 1\nrefs:\n  a: b\n';
  const plan = planCredentialsHeal(good, "1");
  assert.equal(plan.changed, false);
  assert.equal(plan.text, good);
});

test("the string-wanting direction still works", () => {
  const plan = planCredentialsHeal("version: 1\nrefs:\n  a: b\n", '"1"');
  assert.equal(plan.changed, true);
  assert.match(plan.text, /^version: "1"$/m);
});

test("an undetermined expectation changes nothing", () => {
  const text = 'version: "1"\nrefs:\n  a: b\n';
  const plan = planCredentialsHeal(text, null);
  assert.equal(plan.changed, false);
  assert.equal(plan.text, text);
});

// 扁平版式迁移这一支照抄上游，只把写出的标量参数化。上游的行识别正则是
// `^[A-Za-z_][A-Za-z0-9_-]*:[ \t]*\S[ \t]*$` —— `\S` 只吃一个字符，所以真实
// API key 那种多字符值它根本不认。这是上游的既有行为，不在本次故障路径上，
// 故不改；下面两个用例把「实际会发生什么」钉住，免得以后误以为它能用。
test("the flat layout is migrated when upstream's recogniser accepts it", () => {
  const flat = "a: x\nb: y\n";
  const plan = planCredentialsHeal(flat, "1");
  assert.equal(plan.changed, true);
  // 末尾多一个空行是上游 rest.join('\n').replace(/\n*$/, '\n') 的产物，YAML 无害。
  assert.equal(plan.text, "version: 1\nrefs:\n  a: x\n  b: y\n\n");
});

test("upstream's single-character recogniser declines real key values", () => {
  const flat = "anthropic: sk-ant-xxx\n";
  const plan = planCredentialsHeal(flat, "1");
  assert.equal(plan.changed, false, "多字符值不被识别，保持上游行为");
});

test("an unrecognisable document is left for the kernel to report", () => {
  const weird = "- a\n- b\n";
  const plan = planCredentialsHeal(weird, "1");
  assert.equal(plan.changed, false);
  assert.equal(plan.text, weird);
});

test("an empty document is not turned into a bogus version header", () => {
  const plan = planCredentialsHeal("", "1");
  assert.equal(plan.changed, false);
});
