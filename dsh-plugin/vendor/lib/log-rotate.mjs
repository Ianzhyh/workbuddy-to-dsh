/**
 * 桥日志滚动（控制台与 dsh 插件共用同一口径）。
 *
 * 文档承诺「每次启动桥时检查，超过 2MB 滚动为 bridge.log.1」。控制台与插件
 * 各自拉起桥，早先两份实现只同步了控制台那一份，插件路径漏了滚动，长期运行
 * 后日志会无限增长 —— 所以这里保留唯一的实现，两边都 import。
 */
import { existsSync, renameSync, statSync } from 'node:fs';

export const LOG_MAX_BYTES = 2 * 1024 * 1024;

export function rotateLogIfNeeded(file, maxBytes = LOG_MAX_BYTES) {
  try {
    if (existsSync(file) && statSync(file).size > maxBytes) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    /* 滚动失败（文件被占用等）不影响启动 */
  }
}
