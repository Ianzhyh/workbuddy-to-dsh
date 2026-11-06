/**
 * 桥日志滚动（控制台与 dsh 插件共用同一口径）。
 *
 * 文档承诺「每次启动桥时检查，超过 2MB 滚动为 bridge.log.1」。控制台与插件
 * 各自拉起桥，早先两份实现只同步了控制台那一份，插件路径漏了滚动，长期运行
 * 后日志会无限增长 —— 所以这里保留唯一的实现，两边都 import。
 */
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';

export const LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 滚动序号上限。
 *
 * 正常情况只用 `.1`（文档承诺的那个名字）。`EPERM` 兜底时会往后找空位，
 * 但不能无限往后堆 —— 堆到 `.37` 同样是"日志无限增长"，只是分散成了很多份。
 * 到上限时回收最老的那份再重试。
 */
const MAX_INDEX = 9;

/**
 * 检查并滚动日志。
 *
 * @param {string} file 日志文件路径
 * @param {number} [maxBytes] 上限（默认 2MB）
 * @returns {{rotated: boolean, from: string, to: string, error: string}}
 *   滚动结果。**必须能被调用方看见** —— 早先这里 `catch {}` 把失败吞掉了，
 *   而失败的样子是「日志继续无限增长」，一年后才发现。
 */
export function rotateLogIfNeeded(file, maxBytes = LOG_MAX_BYTES) {
  const none = { rotated: false, from: file, to: '', error: '' };
  let size;
  try {
    if (!existsSync(file)) return none;
    size = statSync(file).size;
  } catch (error) {
    return { ...none, error: String(error?.message || error) };
  }
  if (size <= maxBytes) return none;

  /*
   * 首选 `.1`（文档与测试都认这个名字）。
   *
   * ⚠️ Windows 上 `renameSync` 覆盖一个**正被别的句柄打开**的目标会抛 EPERM
   * （实测 `.tmp-audit/probe-logrotate-lock.mjs`：`.1` 被占用时整次滚动静默失败，
   * bridge.log 停在 2MB 继续长）。真实触发场景不少：用户把日志页开着、
   * 杀软/索引服务正扫这个文件、另一个进程在 `Get-Content -Wait`。
   *
   * 所以失败时往后找第一个能用的序号，而不是放弃。全部失败才算真失败，
   * 并把原因带回给调用方。
   */
  const candidates = [1];
  for (let i = 2; i <= MAX_INDEX; i += 1) candidates.push(i);
  let lastError = '';
  for (const index of candidates) {
    const to = `${file}.${index}`;
    try {
      renameSync(file, to);
      return { rotated: true, from: file, to, error: '' };
    } catch (error) {
      lastError = String(error?.message || error);
      // 目标存在且被占用：先删掉旧的再试一次（删不掉就继续往后找）
      try {
        if (existsSync(to)) {
          rmSync(to, { force: true });
          renameSync(file, to);
          return { rotated: true, from: file, to, error: '' };
        }
      } catch { /* 这个序号也不行，换下一个 */ }
    }
  }
  return { ...none, error: lastError };
}
