// 内部 ESM loader 的 resolveSync 调用形状判别。抽成无副作用的纯函数，是为了能在
// 普通 JVM/Node 测试里按实测形状断言 —— shim 本体要 --expose-internals 才能加载，
// 而判别错一次就是 dsh web 启动即 exit 1（见 eac-resolve-sync-shim.test.mjs）。
//
// 两种形状都真实存在，同一次 Android 启动内实测：
//   v2（Node ≥ 24 真实签名，3896 次）：resolveSync(parentURL, request, skipHooks)
//       parentURL 是 URL 字符串，或**首个入口模块那一次为 undefined**；
//       request 是对象 { specifier, phase, attributes }。
//   v1（dsh-client-modules/lib/index.js:682，158 次）：resolveSync(spec, baseUrl, {})
//       第一个参数是裸包名，第二个参数是 baseUrl **字符串**。
//
// 判别只看第二个参数自身的类型：v2 是对象，v1 是字符串。
// 不要改用 `typeof second.specifier === 'string'` —— 入口模块那一次的 specifier
// 是 URL 实例而非字符串，会被误判成 v1，于是 request 对象被塞进 parentURL，
// Node 抛 ERR_INVALID_ARG_TYPE，整个 dsh web 启动失败。

/** v2 的第二个参数是 request 对象；v1 的第二个参数是 baseUrl 字符串。 */
function isRequestObject(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @returns {{translated: boolean, parentURL: unknown, request: unknown, skipHooks: unknown}}
 *   translated 为 false 时，三个参数按原样（含对象同一性）转发。
 */
export function planResolveSyncCall(first, second, third) {
  if (isRequestObject(second)) {
    return { translated: false, parentURL: first, request: second, skipHooks: third };
  }
  return {
    translated: true,
    parentURL: second,
    // String()：v1 的调用方偶尔递 URL 实例，而 Node 内部按 `${request.specifier}`
    // 取值，这里先收敛成字符串，形状才和 v2 完全一致。
    request: { specifier: String(first), attributes: third ?? undefined },
    skipHooks: undefined,
  };
}
