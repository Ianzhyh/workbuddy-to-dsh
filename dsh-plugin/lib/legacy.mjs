/**
 * 旧路由的识别与清理。
 *
 * 在插件出现之前，WorkBuddy 模型是靠两处手写 YAML 注册进 dsh 的：
 *
 *   1. `$DSH_HOME/settings.yaml`            → `llm-pi-ai.providers.workbuddy`
 *   2. `$DSH_HOME/profiles/<p>/cordis.patch.yml` → `- id: llm-pi-ai` 条目里的同一段
 *
 * 插件改为在运行时用 `ctx.llm.registerAdapter('workbuddy', …)` 注册同名的
 * provider 路由，两者**必然撞名**（llm 服务对同一 provider 只允许一个适配器，
 * 第二个注册会抛 DUPLICATE_ADAPTER）。因此插件启动时会：
 *
 *   - 只做**文本级**手术：删掉 `workbuddy:` 这一段（含其缩进子块），
 *     文件里其它任何内容一个字都不动；
 *   - 写入前先备份成 `<文件名>.bak-<时间戳>`；
 *   - 把「删了什么、备份在哪」如实回报给面板与工具，不静默处理。
 *
 * 关掉这个行为：配置 `migrateLegacy: false`，插件就只提示、不改文件。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/** 一行文本的缩进宽度（制表符按 2 计）。 */
function indentOf(line) {
  const match = /^[ \t]*/.exec(line)[0];
  let width = 0;
  for (const ch of match) width += ch === '\t' ? 2 : 1;
  return width;
}

const isBlankOrComment = (line) => line.trim() === '' || line.trim().startsWith('#');

/** YAML 键名可能被引号包起来。 */
const keyName = (line) => {
  const match = /^[ \t]*(?:-\s+)?(['"]?)([A-Za-z0-9_.\-/]+)\1\s*:/.exec(line);
  return match ? match[2] : null;
};

/**
 * 在 `llm-pi-ai` 上下文里定位 `providers.<provider>` 这一段的 [start, end)。
 *
 * @param {string} text 文件全文
 * @param {string} provider 要移除的 provider 名（默认 workbuddy）
 * @returns {{start: number, end: number, providersLine: number, indent: number} | null}
 */
export function locateProviderBlock(text, provider = 'workbuddy') {
  const lines = text.split(/\r?\n/);

  // 1) 找到 llm-pi-ai 这一节/条目
  let anchor = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const name = keyName(lines[i]);
    if (name === 'llm-pi-ai') { anchor = i; break; }
    if (/^\s*-\s*id:\s*['"]?llm-pi-ai['"]?\s*$/.test(lines[i])) { anchor = i; break; }
  }
  if (anchor === -1) return null;
  const anchorIndent = indentOf(lines[anchor]);

  // 2) 找到 providers: —— 必须是 llm-pi-ai 这一节/条目之后、缩进更深的那个
  let providersLine = -1;
  for (let i = anchor + 1; i < lines.length; i += 1) {
    if (isBlankOrComment(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent <= anchorIndent) break; // 走出了这一节
    if (keyName(lines[i]) === 'providers') { providersLine = i; break; }
  }
  if (providersLine === -1) return null;
  const providersIndent = indentOf(lines[providersLine]);

  // 3) 找到 providers 下名为 provider 的键
  /*
   * 子键缩进以**第一个真实子键**为准，不能写死 `providersIndent + 2`：
   * YAML 允许任意更深的缩进，手写配置常见 4 空格一级（`llm-pi-ai:` → 4 →
   * `providers:` → 8 → `workbuddy:`）。写死 +2 会让这段旧路由永远定位不到，
   * 插件随后与 llm-pi-ai 的同名 provider 撞车（DUPLICATE_ADAPTER）并被动降级。
   */
  let start = -1;
  let childIndent = -1;
  for (let i = providersLine + 1; i < lines.length; i += 1) {
    if (isBlankOrComment(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent <= providersIndent) break;
    if (childIndent < 0) childIndent = indent;
    const name = keyName(lines[i]);
    if (indent === childIndent && name === provider) { start = i; break; }
    // providers 下若出现同级的 inline 形式（providers: {...}）就放弃
    if (indent === childIndent && name === null) return null;
  }
  if (start === -1) return null;

  const startIndent = indentOf(lines[start]);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isBlankOrComment(lines[i])) continue;
    if (indentOf(lines[i]) <= startIndent) { end = i; break; }
  }
  return { start, end, providersLine, indent: startIndent };
}

/** providers: 之下是否已经没有任何子键（用于决定要不要写成 `providers: {}`）。 */
function providersIsEmpty(lines, providersLine, indent) {
  for (let i = providersLine + 1; i < lines.length; i += 1) {
    if (isBlankOrComment(lines[i])) continue;
    if (indentOf(lines[i]) <= indent) return true;
    return false;
  }
  return true;
}

/**
 * 从一份文件文本里移除 `providers.<provider>` 段。
 *
 * ## ⚠️ 空 `providers:` 必须**按行号**改写，不能用 `replace(/^.../m)` （实测缺陷）
 *
 * 原先这一行是：
 *
 *     out = out.replace(/^([ \t]*)providers:\s*$/m, '$1providers: {}');
 *
 * `providersIsEmpty()` 判的是 `hit.providersLine` **那个** `providers:`，
 * 而 `replace` 命中的是**全文第一个**匹配行。两个位置一旦不是同一行（很常见：
 * 文件里在本插件段之前还有别的 `xxx:\n  providers:`），后果是两个：
 *
 *   ① 把**别人**的 `providers:` 改成 `{}`，把它下面的子键全变成非法缩进；
 *   ② 自己那个空 `providers:` 仍是裸的（YAML 里是 null），其后兄弟键缩进非法。
 *
 * 实测（`.tmp-audit2/t18-legacy-invalid-yaml.mjs`）：清理后的文件用宿主自带的
 * `yaml` 解析器直接报 `All mapping items must start at the same column` ——
 * 也就是说**下一次 dsh 启动读配置就抛错**。备份文件还在，但用户只会看到启动失败。
 *
 * 现在：先删段，再**按行号**把那一行改写成 `providers: {}`（用同样的缩进），
 * 其余行一个字都不动。
 *
 * @returns {{changed: boolean, text: string}}
 */
export function stripProviderBlock(text, provider = 'workbuddy') {
  const hit = locateProviderBlock(text, provider);
  if (!hit) return { changed: false, text };
  const lines = text.split(/\r?\n/);
  const kept = [...lines.slice(0, hit.start), ...lines.slice(hit.end)];
  /*
   * `hit.providersLine` 是**删除前**的行号；删掉的段在它之后（start > providersLine），
   * 所以删除后它前面的行没有位移 —— 索引仍然有效。
   */
  if (providersIsEmpty(kept, hit.providersLine, indentOf(kept[hit.providersLine] ?? ''))) {
    const idx = hit.providersLine;
    if (idx >= 0 && idx < kept.length && /^([ \t]*)providers:\s*$/.test(kept[idx])) {
      const indent = /^([ \t]*)/.exec(kept[idx])[1];
      // 空映射在 YAML 里是 null，部分消费者会因此报错；显式写成 {}。
      // 只改这**一行**，缩进沿用原值。
      kept[idx] = `${indent}providers: {}`;
    }
  }
  let out = kept.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return { changed: true, text: out };
}

/** 时间戳后缀，与项目既有的备份命名保持一致。 */
function stamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

/**
 * 探测一份文件里是否存在旧路由。**只读，不写**。
 * @param {string} path
 * @param {string} provider
 */
export function detectInFile(path, provider = 'workbuddy') {
  if (!existsSync(path)) return { path, exists: false, found: false };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    return { path, exists: true, found: false, error: String(error?.message || error) };
  }
  const hit = locateProviderBlock(text, provider);
  return {
    path,
    exists: true,
    found: hit !== null,
    ...(hit ? { line: hit.start + 1, lines: hit.end - hit.start } : {}),
  };
}

/**
 * 清理一份文件里的旧路由（先备份）。
 * @param {string} path
 * @param {{ provider?: string, dryRun?: boolean }} [options]
 */
export function cleanFile(path, options = {}) {
  const provider = options.provider || 'workbuddy';
  const detected = detectInFile(path, provider);
  if (!detected.exists) return { path, changed: false, reason: 'not-found' };
  if (detected.error) return { path, changed: false, reason: 'unreadable', error: detected.error };
  if (!detected.found) return { path, changed: false, reason: 'no-legacy-route' };

  const text = readFileSync(path, 'utf8');
  const { changed, text: next } = stripProviderBlock(text, provider);
  if (!changed) return { path, changed: false, reason: 'no-legacy-route' };
  if (options.dryRun) return { path, changed: true, dryRun: true, backup: null, removedLines: detected.lines };

  const backup = `${path}.bak-${stamp()}`;
  try {
    copyFileSync(path, backup);
    writeFileSync(path, next, 'utf8');
  } catch (error) {
    return { path, changed: false, reason: 'write-failed', error: String(error?.message || error), backup };
  }
  return { path, changed: true, backup, removedLines: detected.lines };
}

/**
 * 同时处理 settings.yaml 与 profile patch。
 * @param {{ settingsPath: string, patchPath: string, provider?: string, dryRun?: boolean }} options
 */
export function cleanLegacyRoutes({ settingsPath, patchPath, provider = 'workbuddy', dryRun = false }) {
  const files = [settingsPath, patchPath].map((path) => cleanFile(path, { provider, dryRun }));
  return {
    changed: files.some((f) => f.changed),
    files,
    /*
     * `found` = **确实发现了旧路由**（并因此改动了文件）。
     *
     * 原先写的是 `f.reason === 'no-legacy-route' ? true : f.changed` ——
     * 判据正好反了：`no-legacy-route` 的意思是"没找到旧路由"，却返回 true，
     * 于是面板上的「发现遗留配置」提示**永远亮着**（实测 `.tmp-audit2/t7`：
     * 两个文件都没有旧路由时 `found = true`）。而且首个文件命中
     * `no-legacy-route` 就短路成 true，连第二个文件的真实结果都不看。
     *
     * 正确口径：任一文件 `changed` 才是"找到了并清理了"。
     */
    found: files.some((f) => f.changed === true),
  };
}

/** 只探测（给面板显示用）。 */
export function detectLegacyRoutes({ settingsPath, patchPath, provider = 'workbuddy' }) {
  const files = [settingsPath, patchPath].map((path) => detectInFile(path, provider));
  const found = files.filter((f) => f.found);
  return {
    found: found.length > 0,
    files: found.map((f) => f.path),
    detail: files,
  };
}
