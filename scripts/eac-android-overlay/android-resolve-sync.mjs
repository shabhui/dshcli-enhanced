// Android 运行时补丁：归一化内部 ESM loader 的 resolveSync 签名。
//
// 症状：页面停在 "client-modules: HTML did not preload
// @deepseek-ai/dsh-client-modules/client.js"，客户端插件表恒为空。
//
// 成因：内核的 cordis-plugin-loader 只给内部 loader 打 v1/v2 标签，故意不归一化
// 签名（dsh-agent-presets 里的原话：「whose resolveSync signature differs between
// Node 22 and 24 (ModuleLoader.fromInternal tags the raw object rather than
// normalising it)」）。cordis-plugin-hmr 认标签、按 v2 形状调用；但
// dsh-client-modules:682 无条件用 v1 形状 resolveSync(spec, baseUrl, {})。
// Node ≥ 24 的真实签名是 resolveSync(parentURL, request, shouldSkipSyncHooks)，
// 于是 parentURL 收到裸包名，Node 内部 getPackageScopeConfig 抛 Invalid URL，
// locatePkgJson 返回 undefined，插件表就空了。
//
// 为什么桌面版没事：桌面 vendored 的是 Node 22（真实签名就是 v1），调用形状恰好
// 对得上。Android 运行时带的是 Node 24.18，必须在这一层补。内核属 L3，不改。
//
// 用法（boot-server 在 android 分支自动加）：
//   node --expose-internals --import <此文件> <dsh bin.js> ...
import { createRequire } from 'node:module';

import { planResolveSyncCall } from './resolve-sync-plan.mjs';

const require = createRequire(import.meta.url);

// 只有 v2 运行时才需要翻译。若在 Node 22（真实签名为 v1）上照样翻译，会把
// (spec, baseUrl) 反过来传成 (baseUrl, {specifier: spec})，反而把好的调用弄坏。
// 所以这里自守：拿不准就不动。
//
// 补丁装在原型上，会拦下**所有**调用方，不只是 dsh-client-modules。真机实测一次
// dsh web 启动：3896 次 v2（Node 内部 #resolve）+ 158 次 v1（dsh-client-modules
// :682）。其中首个入口模块那次 v2 调用的 parentURL 是 undefined、specifier 是 URL
// 实例，所以判别只能看第二个参数自身的类型，不能看 specifier 是不是字符串
// —— 详见 resolve-sync-plan.mjs 的注释与 tests/eac-resolve-sync-shim.test.mjs。
const NODE_MAJOR = Number.parseInt(process.versions.node.split('.')[0], 10);

function patch() {
  if (!Number.isFinite(NODE_MAJOR) || NODE_MAJOR < 24) {
    return `skipped: node ${process.versions.node} 的 resolveSync 已是 v1 形状`;
  }
  // --expose-internals 下 internal/* 可直接 require；不走 node-addon-require-builtin
  // （该包没有 android 预编译产物，这也是 boot-server 必须传 --expose-internals 的原因）。
  const loaderMod = require('internal/modules/esm/loader');
  const instance = loaderMod.getOrInitializeCascadedLoader();
  const proto = Object.getPrototypeOf(instance);
  const orig = proto.resolveSync;
  if (typeof orig !== 'function') return 'no resolveSync on prototype';
  if (orig.__eacNormalised) return 'already patched';

  // 判别与形状转换见 resolve-sync-plan.mjs（纯函数，按实测调用形状有测试覆盖）。
  function resolveSync(first, second, third) {
    const plan = planResolveSyncCall(first, second, third);
    if (!plan.translated) return orig.call(this, first, second, third);
    return orig.call(this, plan.parentURL, plan.request);
  }
  resolveSync.__eacNormalised = true;
  Object.defineProperty(proto, 'resolveSync', {
    value: resolveSync,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return 'patched';
}

let status;
try {
  status = patch();
} catch (err) {
  // 补丁失败不阻断启动：插件表会空，但服务本身仍应起得来，便于在页面上看到日志。
  status = `failed: ${(err && err.message) || err}`;
}
if (process.env.EAC_SHIM_VERBOSE) console.log(`[eac-shim] resolveSync: ${status}`);

export const shimStatus = status;
