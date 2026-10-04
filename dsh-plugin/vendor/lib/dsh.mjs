/**
 * DeepSeek Harness 侧：配置读取、模型注册写入。
 *
 * dsh 的配置体系是 cordis patch 分层：`dsh-base` bundle 已内置 `llm-pi-ai`
 * 适配器条目，用户只需在 `$DSH_HOME/settings.yaml` 提供 `llm-pi-ai:` 分节，
 * 该分节热重载，无需重启。凭据走 `$DSH_HOME/.credentials.yaml` 的 `refs:`，
 * 由 `apiKeyEnv` 按请求解析。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.mjs';

/**
 * 读取 dsh 侧全部相关状态。不返回任何凭据值。
 *
 * 路由可能出现在两个位置，二者都算生效：
 *
 *   1. `$DSH_HOME/settings.yaml` —— 官方「用户设置文档」，热重载。
 *   2. `$DSH_HOME/profiles/<name>/cordis.patch.yml` —— profile 的 patch 层。
 *
 * DSH Desktop 0.2.0 会把 (1) 合并进 (2) 并把原文件归档为
 * `settings.yaml.imported`，因此 (1) 消失属正常流程，不能据此判失败。
 */
export function readDshStatus() {
  const out = {
    home: config.dsh.home,
    settingsPath: config.dsh.settingsPath,
    credentialsPath: config.dsh.credentialsPath,
    patchPath: join(config.dsh.profileDir, 'cordis.patch.yml'),
    settingsExists: false,
    settingsHasRoute: false,
    patchHasRoute: false,
    settingsText: '',
    settingsModels: [],
    patchModels: [],
    registeredModels: [],
    hasBridgeKey: false,
    refNames: [],
    bundles: [],
    bundlesOk: true,
  };

  // settings.yaml 写作 `llm-pi-ai:`，patch 层写作 `- id: llm-pi-ai`，两者都要认
  const hasRoute = (text) => /llm-pi-ai/.test(text) && /workbuddy:/.test(text);
  // 缩进随所在文件而变（settings.yaml 是 4 空格，patch 层是 6 空格）
  const modelsUnder = (text) => {
    const seg = text.split(/\r?\n\s*workbuddy:\s*\r?\n/)[1] || '';
    return [...seg.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  };

  if (existsSync(config.dsh.settingsPath)) {
    const text = readFileSync(config.dsh.settingsPath, 'utf8');
    out.settingsExists = true;
    out.settingsText = text;
    out.settingsHasRoute = hasRoute(text);
    out.settingsModels = modelsUnder(text);
  }

  if (existsSync(out.patchPath)) {
    const text = readFileSync(out.patchPath, 'utf8');
    out.patchHasRoute = hasRoute(text);
    if (out.patchHasRoute) out.patchModels = modelsUnder(text);
  }

  // settings.yaml 是**用户最新的意图**，patch 层是 DSH Desktop 导入过的历史快照。
  // 两者取并集会把「以前注册过、现在已取消」的模型也算进去，表现为"勾 2 个却显示一堆"。
  // 因此有 settings.yaml 路由时以它为准，否则才退回 patch。
  out.registeredModels = out.settingsHasRoute
    ? [...new Set(out.settingsModels)]
    : [...new Set(out.patchModels)];

  out.routeLive = out.settingsHasRoute || out.patchHasRoute;
  out.routeSource = out.settingsHasRoute
    ? 'settings.yaml'
    : out.patchHasRoute ? 'cordis.patch.yml' : '';

  if (existsSync(config.dsh.credentialsPath)) {
    const text = readFileSync(config.dsh.credentialsPath, 'utf8');
    out.hasBridgeKey = text.includes('WORKBUDDY_BRIDGE_KEY');
    // 只回传键名，绝不回传值
    out.refNames = (text.match(/^\s{2}([A-Z][A-Z0-9_]*):/gm) || [])
      .map((l) => l.trim().replace(':', ''));
  }

  // profile 的 bundles 是否都能解析；缺一个整个 profile 就起不来
  const pkgPath = join(config.dsh.profileDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const list = pkg.dsh?.profile?.bundles || [];
      for (const name of list) {
        const candidates = [
          join(config.dsh.runtime, 'node_modules', name),
          join(config.dsh.home, 'profiles', 'node_modules', name),
          join(config.dsh.profileDir, 'node_modules', name),
        ];
        out.bundles.push({ name, installed: candidates.some((c) => existsSync(c)) });
      }
    } catch (err) {
      out.bundlesError = err.message;
    }
  }
  out.bundlesOk = out.bundles.every((b) => b.installed);

  return out;
}

function yamlStr(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 组装 settings.yaml 全文。
 *
 * 只生成 workbuddy 这一条路由，不改动用户的其它分节——因此写入会覆盖整个
 * 文件，调用方必须先备份（见 writeRegistration）。
 */
export function buildSettings(models) {
  const lines = [
    '# DeepSeek Harness 用户设置文档（$DSH_HOME/settings.yaml，热重载）。',
    '#',
    '# 由 WorkBuddy 中转控制台生成：llm-pi-ai 分节把本地桥注册为一条 OpenAI 兼容路由。',
    '# 使用前需先启动桥：项目根目录 启动.cmd（macOS/Linux：scripts/start.sh）→「启动桥服务」。',
    'llm-pi-ai:',
    '  providers:',
    '    workbuddy:',
    '      displayName: WorkBuddy',
    '      # 按请求解析的凭据引用；实际值在 $DSH_HOME/.credentials.yaml。',
    '      apiKeyEnv: WORKBUDDY_BRIDGE_KEY',
    '      api: openai-completions',
    `      baseURL: ${config.bridge.url}/v1`,
    '      models:',
  ];
  for (const m of models) {
    lines.push(`        - id: ${m.id}`);
    lines.push(`          name: ${yamlStr(m.name || m.id)}`);
    if (m.contextWindow) lines.push(`          contextWindow: ${m.contextWindow}`);
    if (m.maxTokens) lines.push(`          maxTokens: ${m.maxTokens}`);
    lines.push('          input:');
    lines.push('            - text');
  }
  return `${lines.join('\n')}\n`;
}

/** 生成 cordis.patch.yml 中 llm-pi-ai 条目的文本（缩进对齐 patch 层）。 */
function buildPatchEntry(models) {
  const yamlStr = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      workbuddy:',
    '        displayName: WorkBuddy',
    '        apiKeyEnv: WORKBUDDY_BRIDGE_KEY',
    '        api: openai-completions',
    `        baseURL: ${config.bridge.url}/v1`,
    '        models:',
  ];
  for (const m of models) {
    lines.push(`          - id: ${m.id}`);
    lines.push(`            name: ${yamlStr(m.name || m.id)}`);
    if (m.contextWindow) lines.push(`            contextWindow: ${m.contextWindow}`);
    if (m.maxTokens) lines.push(`            maxTokens: ${m.maxTokens}`);
    lines.push('            input:');
    lines.push('              - text');
  }
  return lines.join('\n');
}

/** 就地替换 patch 文本里的 llm-pi-ai 条目；不存在则追加到数组末尾。 */
function upsertPatchEntry(text, entryText) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '- id: llm-pi-ai');

  if (start === -1) {
    const sep = text.endsWith('\n') ? '' : '\n';
    return `${text}${sep}${entryText}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^- id: /.test(lines[i])) { end = i; break; }
  }
  return [
    ...lines.slice(0, start),
    ...entryText.split('\n'),
    ...lines.slice(end),
  ].join('\n');
}

/**
 * 写入模型注册，返回结果。写入前自动备份。
 *
 * 同时写两处，各自的原因不同：
 *   settings.yaml      —— 官方「用户设置文档」，DSH Desktop 会把它导入 patch 层
 *   cordis.patch.yml   —— DSH **实际生效**的位置，立即生效、不必等重启
 *
 * 只写前者会留下「patch 里还是旧列表」的不一致：界面读到的已注册模型与实际
 * 生效的不符（表现为勾 2 个却显示一堆）。
 */
export function writeRegistration(models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('models 不能为空');
  }
  const clean = models.map((m) => ({
    id: String(m.id),
    name: m.name ? String(m.name) : String(m.id),
    contextWindow: Number(m.contextWindow) || 0,
    maxTokens: Number(m.maxTokens) || 0,
  }));

  let backup = null;
  if (existsSync(config.dsh.settingsPath)) {
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    backup = `${config.dsh.settingsPath}.bak-${stamp}`;
    copyFileSync(config.dsh.settingsPath, backup);
  }
  writeFileSync(config.dsh.settingsPath, buildSettings(clean), 'utf8');

  // 同步 patch 层：否则那里仍是旧列表，界面读到的与实际生效的不一致
  const patchPath = join(config.dsh.profileDir, 'cordis.patch.yml');
  let patchBackup = null;
  try {
    if (existsSync(patchPath)) {
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      patchBackup = `${patchPath}.bak-${stamp}`;
      copyFileSync(patchPath, patchBackup);
      const next = upsertPatchEntry(readFileSync(patchPath, 'utf8'), buildPatchEntry(clean));
      writeFileSync(patchPath, next, 'utf8');
    }
  } catch (err) {
    // patch 写失败不影响 settings.yaml 已落盘的结果，但要让调用方知道
    return {
      saved: true,
      path: config.dsh.settingsPath,
      backup,
      count: clean.length,
      patchError: String(err.message || err),
    };
  }

  return {
    saved: true,
    path: config.dsh.settingsPath,
    backup,
    patchPath,
    patchBackup,
    count: clean.length,
  };
}
