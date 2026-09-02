// Android 上 SELinux 禁止应用在自己数据目录里建硬链接（真机实测 link -> EACCES），
// 而内核的 dsh-session-persistence-jsonl 用 link(tmp, final) 发布会话文件，于是
// 每轮对话结束都报：
//
//   本轮运行失败 EACCES: permission denied, link '.../session.jsonl.zstd.<hash>.tmp'
//   -> '.../session.jsonl.zstd'
//
// 这些用例钉住兜底的两条底线：内容要真的落到最终路径，以及【目标已存在必须 EEXIST】——
// 上游选 link 就是为了这个原子性，换成裸 rename 会静默覆盖掉别人的会话记录。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installHardlinkFallback,
  isHardlinkUnsupported,
  publishByRename,
} from "../scripts/eac-android-overlay/android-hardlink.mjs";

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "paseo-hardlink-"));
}

test("只把平台性拒绝当成不支持", () => {
  for (const code of ["EACCES", "EPERM", "ENOSYS", "EOPNOTSUPP", "ENOTSUP"]) {
    assert.equal(isHardlinkUnsupported(Object.assign(new Error(code), { code })), true, code);
  }
  // 这些是真错误，兜底会掩盖问题，必须原样抛出。
  for (const code of ["ENOENT", "EEXIST", "EXDEV", "EIO"]) {
    assert.equal(isHardlinkUnsupported(Object.assign(new Error(code), { code })), false, code);
  }
  assert.equal(isHardlinkUnsupported(null), false);
  assert.equal(isHardlinkUnsupported(new Error("no code")), false);
});

test("publishByRename 把内容送到最终路径", async () => {
  const dir = await tempDir();
  const tmp = path.join(dir, "a.tmp");
  const final = path.join(dir, "a.final");
  await fs.writeFile(tmp, "payload");

  await publishByRename(fs, tmp, final);

  assert.equal(await fs.readFile(final, "utf8"), "payload");
  // tmp 已被 rename 消耗掉；上游随后还会 rm(tmp, {force:true})，不能因此报错。
  await assert.rejects(() => fs.stat(tmp), { code: "ENOENT" });
  await fs.rm(dir, { recursive: true, force: true });
});

test("目标已存在时抛 EEXIST，且不碰原文件", async () => {
  const dir = await tempDir();
  const tmp = path.join(dir, "a.tmp");
  const final = path.join(dir, "a.final");
  await fs.writeFile(tmp, "new");
  await fs.writeFile(final, "original");

  await assert.rejects(() => publishByRename(fs, tmp, final), (error) => {
    assert.equal(error.code, "EEXIST");
    assert.equal(error.syscall, "link", "上游按 link 的错误形状判断");
    return true;
  });

  // 这是本条兜底的核心：绝不能静默覆盖已有会话记录。
  assert.equal(await fs.readFile(final, "utf8"), "original");
  await fs.rm(dir, { recursive: true, force: true });
});

test("rename 失败时清掉占位符，不留空文件", async () => {
  const dir = await tempDir();
  const final = path.join(dir, "a.final");
  const failing = {
    open: fs.open,
    rm: fs.rm,
    rename: async () => {
      const error = new Error("EIO: io error");
      error.code = "EIO";
      throw error;
    },
  };

  await assert.rejects(() => publishByRename(failing, path.join(dir, "nope.tmp"), final),
    { code: "EIO" });

  // 留下空文件会让内核的 rejectExistingLog 误判成「盘上已有日志」，
  // 把这个会话永久锁死 —— 比原始错误更难查。
  await assert.rejects(() => fs.stat(final), { code: "ENOENT" });
  await fs.rm(dir, { recursive: true, force: true });
});

test("EACCES 的 link 被兜底接住，内容照样落地", async () => {
  const dir = await tempDir();
  const tmp = path.join(dir, "a.tmp");
  const final = path.join(dir, "a.final");
  await fs.writeFile(tmp, "payload");

  // 复刻 Android：link 永远 EACCES，其余走真实 fs。
  const androidLike = {
    open: fs.open,
    rename: fs.rename,
    rm: fs.rm,
    link: async () => {
      const error = new Error("EACCES: permission denied, link");
      error.code = "EACCES";
      throw error;
    },
  };

  assert.equal(installHardlinkFallback(androidLike), true);
  await androidLike.link(tmp, final);

  assert.equal(await fs.readFile(final, "utf8"), "payload");
  await fs.rm(dir, { recursive: true, force: true });
});

test("能建硬链接的平台上不改变行为", async () => {
  const dir = await tempDir();
  const tmp = path.join(dir, "a.tmp");
  const final = path.join(dir, "a.final");
  await fs.writeFile(tmp, "payload");

  const real = { open: fs.open, rename: fs.rename, rm: fs.rm, link: fs.link };
  installHardlinkFallback(real);
  await real.link(tmp, final);

  // 真硬链接：两条路径同一个 inode，tmp 仍在。
  const a = await fs.stat(tmp);
  const b = await fs.stat(final);
  assert.equal(a.ino, b.ino);
  await fs.rm(dir, { recursive: true, force: true });
});

test("重复安装是幂等的", () => {
  const target = { link: async () => {}, open: fs.open, rename: fs.rename, rm: fs.rm };
  assert.equal(installHardlinkFallback(target), true);
  const first = target.link;
  assert.equal(installHardlinkFallback(target), false, "第二次不应再包一层");
  assert.equal(target.link, first);
});

test("没有 link 可打时安全返回", () => {
  assert.equal(installHardlinkFallback(null), false);
  assert.equal(installHardlinkFallback({}), false);
});

// 这一条钉住 android-fs-patch.mjs 里最容易被「统一风格」改坏的地方：
// 内核用具名导入 `import { link } from "node:fs/promises"`，而内建模块的 ESM facade
// 在创建时快照属性值。若 preload 自己先 import 过 node:fs/promises，facade 就在改写
// 之前建好，具名导入拿到的仍是原版 link，补丁静默失效。只用 createRequire 才行。
test("preload 必须只用 createRequire，具名导入才能看到补丁", async () => {
  const dir = await tempDir();
  const consumer = path.join(dir, "consumer.mjs");
  await fs.writeFile(consumer,
    'import { link } from "node:fs/promises";\n'
    + 'console.log(JSON.stringify({named: link.__probe === true}));\n');

  const viaRequire = path.join(dir, "via-require.mjs");
  await fs.writeFile(viaRequire,
    'import { createRequire } from "node:module";\n'
    + 'const require = createRequire(import.meta.url);\n'
    + 'const fsp = require("node:fs/promises");\n'
    + 'fsp.link = async () => {}; fsp.link.__probe = true;\n');

  const viaImport = path.join(dir, "via-import.mjs");
  await fs.writeFile(viaImport,
    'import fsp from "node:fs/promises";\n'
    + 'fsp.link = async () => {}; fsp.link.__probe = true;\n');

  const run = async (preload) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { pathToFileURL } = await import("node:url");
    // Windows 上 --import 只吃 file:// URL，裸 D:\... 会 ERR_UNSUPPORTED_ESM_URL_SCHEME。
    const { stdout } = await promisify(execFile)(
      process.execPath, ["--import", pathToFileURL(preload).href, consumer]);
    return JSON.parse(stdout.trim()).named;
  };

  assert.equal(await run(viaRequire), true, "createRequire：具名导入应看到补丁");
  assert.equal(await run(viaImport), false,
    "import：facade 已提前建好，具名导入看不到补丁 —— 这正是不能用 import 的原因");

  await fs.rm(dir, { recursive: true, force: true });
});

test("入口文件不得 import node:fs/promises", async () => {
  const src = await fs.readFile(
    new URL("../scripts/eac-android-overlay/android-fs-patch.mjs", import.meta.url), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/import\s+[^;]*from\s*['"]node:fs\/promises['"]/.test(code), false,
    "改成 import 会让补丁静默失效，见上一条用例");
  assert.match(code, /createRequire\(/);
});
