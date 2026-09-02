// Android 上 SELinux 禁止应用在自己的数据目录里建硬链接：即使同一 UID、同一 ext4
// 分区，link() 也返回 EACCES（真机实测，见下）。而内核的
// @deepseek-ai/dsh-session-persistence-jsonl 的 materializePosix 用
// `link(tmp, finalPath)` 发布会话文件，于是每一轮对话结束都失败：
//
//   本轮运行失败 EACCES: permission denied, link
//   '.../session.jsonl.zstd.<hash>.tmp' -> '.../session.jsonl.zstd'
//
// 真机实测的原语（/data/data/<pkg>/files/home/.dsh 下，ext3/4）：
//   link                    -> EACCES
//   open(final, 'wx')       -> ok
//   rename(tmp, final)      -> ok，内容完整
//   open(final, 'wx') 再来   -> EEXIST
//
// 关键点：不能直接把 link 换成 rename。上游选 link 是为了「目标已存在就原子失败」
// （EEXIST），rename 会静默覆盖，等于把别人的会话记录悄悄冲掉。所以兜底必须保住
// create-only 语义：先用 'wx' 原子占位（已存在就抛 EEXIST，和 link 一致），
// 再 rename 覆盖自己刚占的那个位。
//
// 只在 link 明确报「不支持」时兜底；其它错误原样抛出，保持上游的报错路径。

/** link() 被平台/策略拒绝，而不是调用方用错了。 */
export function isHardlinkUnsupported(error) {
  if (!error || typeof error.code !== "string") return false;
  return (
    error.code === "EACCES" ||
    error.code === "EPERM" ||
    error.code === "ENOSYS" ||
    error.code === "EOPNOTSUPP" ||
    error.code === "ENOTSUP"
  );
}

/** 造一个和 link() 形状一致的 EEXIST，让上游的判断照旧生效。 */
function eexist(tmp, finalPath) {
  const error = new Error(
    `EEXIST: file already exists, link '${tmp}' -> '${finalPath}'`,
  );
  error.code = "EEXIST";
  error.syscall = "link";
  error.path = tmp;
  error.dest = finalPath;
  return error;
}

/**
 * 无硬链接时的 create-only 发布：'wx' 占位 + rename。
 *
 * fsLike 需要 open / rename / rm（形状同 node:fs/promises），由调用方注入，
 * 便于测试替换。
 */
export async function publishByRename(fsLike, tmp, finalPath) {
  let handle;
  try {
    // 'wx' = O_CREAT|O_EXCL|O_WRONLY：目标已存在就 EEXIST，这就是 link 的语义。
    handle = await fsLike.open(finalPath, "wx", 0o600);
  } catch (error) {
    if (error && error.code === "EEXIST") throw eexist(tmp, finalPath);
    throw error;
  }
  await handle.close();
  try {
    // rename 连 inode 一起换掉，最终文件的权限来自 tmp —— 与 link 的结果一致。
    await fsLike.rename(tmp, finalPath);
  } catch (error) {
    // 占位符必须清掉：留下一个空文件会让下一次 rejectExistingLog 误判成
    // 「盘上已有日志」，把这个会话永久锁死。
    try {
      await fsLike.rm(finalPath, { force: true });
    } catch {}
    throw error;
  }
}

/**
 * 给 fs/promises 的 link 装上兜底。返回是否真的打了补丁（重复调用是幂等的）。
 *
 * 必须在 dsh-session-persistence-jsonl 被实例化之前调用：它在模块顶层
 * `import { link } from "node:fs/promises"`，绑定在实例化时求值，之后再改就晚了。
 */
export function installHardlinkFallback(fsPromises) {
  if (!fsPromises || typeof fsPromises.link !== "function") return false;
  if (fsPromises.link.__paseoHardlinkFallback) return false;

  const nativeLink = fsPromises.link.bind(fsPromises);
  const patched = async function link(existingPath, newPath) {
    try {
      return await nativeLink(existingPath, newPath);
    } catch (error) {
      if (!isHardlinkUnsupported(error)) throw error;
      return await publishByRename(fsPromises, existingPath, newPath);
    }
  };
  patched.__paseoHardlinkFallback = true;
  fsPromises.link = patched;
  return true;
}
