/**
 * 项目根 `.env` 的读写 —— **插件与控制台共用一份**。
 *
 * ## 为什么要有这个模块
 *
 * 面板的「自动换号」开关、控制台的同名开关写的是同一个 `.env` 键。我先在
 * `dsh-plugin/lib/index.js` 里实现了 `updateProjectEnv`，然后在控制台直接调用 ——
 * 但控制台根本 import 不到那个函数，运行时会 `ReferenceError`。
 *
 * 两边各写一份也一样糟糕：`.env` 的解析规则（`export` 前缀、引号、重复键）
 * 一旦分叉，"在面板里改了、控制台看到的是旧值"会变成常态。
 *
 * 所以读写都收在这里，插件与控制台都从这里 import。
 *
 * ## 规则（与 `config.mjs` / `readProjectEnv` 保持一致）
 *
 * · 容忍 `export KEY=VALUE`（不剥掉前缀会让键名变成 "export KEY"，配置静默失效）；
 * · 去掉成对的单/双引号；
 * · 写：键已存在就地替换（位置不变），不存在追加；空值 = 删除该行；
 * · 重复键只保留第一条（`.env` 里后者覆盖前者，留着重键更让人困惑）；
 * · 写入走临时文件 + rename：中途崩溃不会留下半个 `.env`。
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 读项目根 `.env` 成普通对象。
 *
 * @param {string} projectRoot
 * @returns {Record<string, string>}
 */
export function readProjectEnv(projectRoot) {
  const out = {};
  if (!projectRoot) return out;
  const file = join(projectRoot, '.env');
  if (!existsSync(file)) return out;
  try {
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const body = line.replace(/^export\s+/u, '');
      const eq = body.indexOf('=');
      if (eq <= 0) continue;
      const key = body.slice(0, eq).trim();
      let value = body.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch { /* 读不到就当空文件：调用方都有回退值 */ }
  return out;
}

/**
 * 把**一个键**写回 `.env`，其余内容（注释、顺序、其它键）原样保留。
 *
 * @param {string} projectRoot
 * @param {string} key 必须是大写下划线形式（防注入）
 * @param {string} value 空串 = 删除该行（回到默认）
 * @returns {{ ok: boolean, file: string, error?: string }}
 */
export function updateProjectEnv(projectRoot, key, value) {
  if (!projectRoot) return { ok: false, file: '', error: '找不到项目根目录' };
  const name = String(key || '').trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    return { ok: false, file: '', error: `非法的变量名：${name}` };
  }
  const file = join(projectRoot, '.env');
  let lines = [];
  try {
    lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  } catch (e) {
    return { ok: false, file, error: String(e?.message || e) };
  }

  const text = String(value ?? '').trim();
  const re = new RegExp(`^(\\s*)(export\\s+)?${name}\\s*=`);
  let replaced = false;
  const next = [];
  for (const line of lines) {
    if (re.test(line)) {
      if (replaced) continue;
      replaced = true;
      if (!text) continue;
      next.push(`${name}=${text}`);
      continue;
    }
    next.push(line);
  }
  if (!replaced && text) {
    while (next.length && next[next.length - 1].trim() === '') next.pop();
    next.push(`${name}=${text}`);
    next.push('');
  }

  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, next.join('\n'), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 临时文件可能没建起来 */ }
    return { ok: false, file, error: String(e?.message || e) };
  }
  return { ok: true, file };
}