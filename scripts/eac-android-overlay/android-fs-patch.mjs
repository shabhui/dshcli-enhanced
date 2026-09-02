// Android 运行时补丁入口：给 fs/promises 的 link 装上无硬链接兜底。
//
// 症状：每轮对话结束后页面显示
//   本轮运行失败 EACCES: permission denied, link
//   '.../session.jsonl.zstd.<hash>.tmp' -> '.../session.jsonl.zstd'
// 会话记录写不下去。成因与兜底策略见 android-hardlink.mjs。
//
// ── 为什么这个文件只用 createRequire，绝不 import node:fs/promises ──
//
// 内核的 dsh-session-persistence-jsonl 用**具名导入**取 link：
//   import { link } from "node:fs/promises";
// 而 Node 的内建模块 ESM facade 在**创建时快照属性值**。如果本文件先
// `import fsp from 'node:fs/promises'`，facade 就在改写之前建好了，之后再改对象
// 属性，具名导入拿到的仍是原版 link —— 补丁静默失效。
//
// 本地 Node 24.16 实测（node --import <preload> <consumer>）：
//   preload 用 import 改写   -> 具名导入看到补丁：false
//   preload 只用 createRequire -> 具名导入看到补丁：true
// 因为 createRequire 走 CJS 通道，不会提前创建 ESM facade，等消费方第一次具名导入
// 时才创建，于是快照到的是已打好的补丁。
//
// 所以：本文件不得出现 `import ... from 'node:fs/promises'`，也不要把 require 换成
// import「统一风格」。tests/eac-android-hardlink.test.mjs 里有一条子进程用例钉住
// 这个行为，改坏了会红。
//
// 同理，本补丁必须排在其它 --import 之前：android-resolve-sync.mjs 会 require
// internal/modules/esm/loader，那条链路有可能顺带把 fs/promises 的 facade 建起来。
//
// 用法（boot-server 在 android 分支自动加）：
//   node --import <此文件> --import <android-resolve-sync.mjs> <dsh bin.js> ...
import { createRequire } from 'node:module';

import { installHardlinkFallback } from './android-hardlink.mjs';

const require = createRequire(import.meta.url);

let status;
try {
  // 只能这样取；理由见上。
  const fsPromises = require('node:fs/promises');
  status = installHardlinkFallback(fsPromises) ? 'patched' : 'already patched';
} catch (err) {
  // 补丁失败不阻断启动：会话落盘会报错，但服务本身仍应起得来，
  // 便于在页面日志里看到真实原因。
  status = `failed: ${(err && err.message) || err}`;
}
if (process.env.EAC_SHIM_VERBOSE) console.log(`[eac-shim] fs.link fallback: ${status}`);

export const fsPatchStatus = status;
