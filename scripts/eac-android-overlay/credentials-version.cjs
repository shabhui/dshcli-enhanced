'use strict';
// .credentials.yaml 的 version 标量该写数字还是字符串 —— 纯决策，便于测试。
//
// 上游 5.3.1 自相矛盾：boot-server.js 的 healCredentialsVersion 无条件写
// `version: "1"`（字符串），而同一个 deb 里的 dsh-credentials-local 校验的是
// `fields["version"] !== 1`（数字）。真机上内核自己写出的是数字 1，被上游的
// heal 改成字符串后，下一次启动必定死在：
//
//   credentials-local: .../.credentials.yaml declares version "1";
//   this build reads version 1
//
// 所以形态不能写死，要问【实际会跑的那个校验器】。判别失败时一律不动 —— 沿用
// 上游「形态看不懂则不动，交由内核报错路径展示」的立场，猜错比不猜更糟。
const EXPECTED_NUMBER = '1';
const EXPECTED_STRING = '"1"';

/**
 * 从 dsh-credentials-local 的源码里读出它要求的 version 标量形态。
 *
 * @param {string|null|undefined} validatorSource lib/index.js 的内容
 * @returns {'1'|'"1"'|null} 判别不出来时返回 null
 */
function expectedVersionScalar(validatorSource) {
  if (typeof validatorSource !== 'string' || validatorSource === '') return null;
  const match = /fields\[(?:"version"|'version')\]\s*!==\s*(1|"1"|'1')/.exec(validatorSource);
  if (!match) return null;
  return match[1] === '1' ? EXPECTED_NUMBER : EXPECTED_STRING;
}

/**
 * 决定 .credentials.yaml 要不要改、改成什么。逻辑照搬上游 healCredentialsVersion，
 * 唯一的差别是写出的标量形态由 expected 决定，而不是写死成 `"1"`。
 *
 * @param {string} text 现有文件内容
 * @param {'1'|'"1"'|null} expected 目标形态；null 表示不动
 * @returns {{changed: boolean, text: string}}
 */
function planCredentialsHeal(text, expected) {
  if (typeof text !== 'string') return { changed: false, text: '' };
  if (expected !== EXPECTED_NUMBER && expected !== EXPECTED_STRING) {
    return { changed: false, text };
  }

  // 只认顶层（零缩进）的 version 行。嵌套的 payload.version 属于别的 schema，
  // 改了会把凭据本身弄坏 —— 上游那条正则允许前导空白，这里收紧。
  let fixed = text.replace(/^version:[ \t]*(?:1|['"]1['"])[ \t]*$/m, `version: ${expected}`);

  if (!/^version:[ \t]*\S/m.test(fixed)) {
    const scalar = [];
    const rest = [];
    let inRecords = false;
    let recognizable = true;
    for (const line of fixed.split('\n')) {
      if (/^records:[ \t]*$/.test(line)) {
        inRecords = true;
        rest.push(line);
        continue;
      }
      if (inRecords) {
        rest.push(line);
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_-]*:[ \t]*\S[ \t]*$/.test(line)) {
        scalar.push(line);
        continue;
      }
      if (line.trim() === '') continue;
      recognizable = false;
      break;
    }
    if (recognizable && scalar.length > 0) {
      fixed =
        `version: ${expected}\nrefs:\n` +
        scalar.map((l) => '  ' + l).join('\n') +
        '\n' +
        rest.join('\n').replace(/\n*$/, '\n');
    }
  }

  return { changed: fixed !== text, text: fixed };
}

module.exports = { expectedVersionScalar, planCredentialsHeal };
