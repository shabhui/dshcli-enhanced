import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const load = () => require("../scripts/android-dpkg-relocate.cjs");
const linuxDeb = process.platform === "linux" && spawnSync("dpkg-deb", ["--version"]).status === 0;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsha-deb-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root, name, contents, mode = 0o644) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode });
  return target;
}

test("relocation preserves binary size across chunk boundaries and never follows symlinks", (t) => {
  const root = fixture(t);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0xff);
  bytes.write("com.termux", 1024 * 1024 - 4);
  const file = put(root, "data/data/com.termux/files/usr/bin/tool", bytes, 0o755);
  if (process.platform !== "win32") {
    fs.symlinkSync("/data/data/com.termux/files/usr/bin/tool", `${file}-link`);
  }
  load().relocateTree(root);
  const target = file.replace("com.termux", "com.dshcli");
  const actual = fs.readFileSync(target);
  bytes.write("com.dshcli", 1024 * 1024 - 4);
  assert.deepEqual(actual, bytes);
  if (process.platform !== "win32") {
    assert.equal(fs.readlinkSync(`${target}-link`), "/data/data/com.dshcli/files/usr/bin/tool");
    assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  }
});

test("deb conversion retains the original and rewrites paths, scripts, links and checksums", { skip: !linuxDeb }, (t) => {
  const root = fixture(t);
  const tree = path.join(root, "input");
  const prefix = "/data/data/com.dshcli/files/usr";
  put(tree, "DEBIAN/control", "Package: dsha-test\nVersion: 1.0\nArchitecture: all\nMaintainer: Test <test@example.com>\nDescription: relocation fixture\n");
  put(tree, "DEBIAN/postinst", "#!/data/data/com.termux/files/usr/bin/sh\necho com.termux\n", 0o755);
  put(tree, "DEBIAN/conffiles", "/data/data/com.termux/files/usr/etc/test.conf\n");
  const relative = "data/data/com.termux/files/usr/etc/test.conf";
  put(tree, relative, "com.termux\n");
  put(tree, "DEBIAN/md5sums", `00000000000000000000000000000000  ${relative}\n`);
  const binary = put(tree, "data/data/com.termux/files/usr/bin/dpkg", "\x7fELFcom.termux", 0o755);
  fs.symlinkSync("/data/data/com.termux/files/usr/bin/dpkg", `${binary}-link`);
  const original = path.join(root, "original.deb");
  execFileSync("dpkg-deb", ["--build", tree, original]);
  const before = fs.readFileSync(original);
  const converted = load().relocateDeb(original, path.join(root, "converted"), "/usr/bin/dpkg-deb", prefix);
  const extracted = path.join(root, "extracted");
  execFileSync("dpkg-deb", ["--raw-extract", converted, extracted]);
  assert.deepEqual(fs.readFileSync(original), before);
  assert.equal(fs.existsSync(path.join(extracted, "data/data/com.termux")), false);
  assert.match(fs.readFileSync(path.join(extracted, "DEBIAN/postinst"), "utf8"), /com\.dshcli/u);
  assert.equal(fs.readlinkSync(path.join(extracted, prefix, "bin/dpkg-link")), `${prefix}/bin/dpkg`);
  assert.match(fs.readFileSync(path.join(extracted, prefix, "bin/dpkg"), "utf8"), /dsha-dpkg-relocate\.js/u);
  assert.equal(fs.readFileSync(path.join(extracted, prefix, "libexec/dsha-runtime/dpkg"), "utf8"), "\x7fELFcom.dshcli");
  const md5 = createHash("md5").update("com.dshcli\n").digest("hex");
  assert.match(fs.readFileSync(path.join(extracted, "DEBIAN/md5sums"), "utf8"), new RegExp(`${md5}  data/data/com.dshcli/files/usr/etc/test.conf`));
  assert.equal(fs.readFileSync(path.join(extracted, "DEBIAN/conffiles"), "utf8"), `${prefix}/etc/test.conf\n`);
  const twice = load().relocateDeb(converted, path.join(root, "twice"), "/usr/bin/dpkg-deb", prefix);
  const secondTree = path.join(root, "second-tree");
  execFileSync("dpkg-deb", ["--raw-extract", twice, secondTree]);
  assert.equal(fs.readFileSync(path.join(secondTree, prefix, "libexec/dsha-runtime/dpkg"), "utf8"), "\x7fELFcom.dshcli");
});

test("dpkg keeps apt status descriptors open and returns failed subprocess status", (t) => {
  const root = fixture(t);
  const fd = fs.openSync(path.join(root, "status"), "w");
  try {
    const result = load().run(process.execPath, ["-e", `require('node:fs').writeSync(${fd}, 'status'); process.exit(23)`], { descriptors: [fd] });
    assert.equal(result.status, 23);
    assert.equal(fs.readFileSync(path.join(root, "status"), "utf8"), "status");
  } finally {
    fs.closeSync(fd);
  }
});

test("dpkg installs combined-short and recursive operands without rewriting option values", { skip: !linuxDeb }, (t) => {
  const root = fixture(t);
  const tree = path.join(root, "input");
  put(tree, "DEBIAN/control", "Package: dsha-probe\nVersion: 1\nArchitecture: all\nMaintainer: Test <test@example.com>\nDescription: install fixture\n");
  put(tree, "data/data/com.termux/files/usr/share/dsha-probe", "com.termux\n");
  const downloads = path.join(root, "downloads");
  fs.mkdirSync(downloads);
  const archive = path.join(downloads, "probe.deb");
  execFileSync("dpkg-deb", ["--build", tree, archive]);
  const prefix = path.join(root, "tools");
  fs.mkdirSync(path.join(prefix, "libexec/dsha-runtime"), { recursive: true });
  for (const tool of ["dpkg", "dpkg-deb"]) {
    fs.symlinkSync(`/usr/bin/${tool}`, path.join(prefix, "libexec/dsha-runtime", tool));
  }
  const oldPrefix = process.env.PREFIX;
  process.env.PREFIX = prefix;
  try {
    for (const flag of ["-iG", "-iR"]) {
      const installRoot = path.join(root, `installed${flag}`);
      fs.mkdirSync(installRoot);
      const status = fs.openSync(path.join(root, `status${flag}`), "w");
      try {
        const result = load().main("dpkg", ["--root", installRoot, "--log", path.join(root, "dpkg.log"), "--force-not-root", "--force-bad-path", "--status-fd", String(status), flag, flag === "-iR" ? downloads : archive]);
        assert.equal(result.status, 0);
      } finally { fs.closeSync(status); }
      assert.equal(fs.existsSync(path.join(installRoot, "data/data/com.termux")), false);
      assert.equal(fs.readFileSync(path.join(installRoot, "data/data/com.dshcli/files/usr/share/dsha-probe"), "utf8"), "com.dshcli\n");
      assert.match(fs.readFileSync(path.join(root, `status${flag}`), "utf8"), /installed/u);
      assert.deepEqual(fs.readdirSync(path.join(prefix, "tmp")), []);
    }
  } finally {
    if (oldPrefix === undefined) delete process.env.PREFIX;
    else process.env.PREFIX = oldPrefix;
  }
});
