#!/usr/bin/env node
/**
 * 一键接入 —— 命令行版。
 *
 *   node tools/connect.mjs status                        列出三个客户端的状态与将要改动什么
 *   node tools/connect.mjs apply <客户端> [--model <id>]   写入（codex | claude | opencode）
 *   node tools/connect.mjs profile <客户端>                写 profile 文件（**不动基础配置**，用 codex -p <name> 启动）
 *   node tools/connect.mjs native <客户端>                 切回客户端自己的模型（记录与目录留着）
 *   node tools/connect.mjs bridge <客户端>                 从原始模型切回桥（沿用记录里那批模型）
 *   node tools/connect.mjs undo <客户端>                   撤销（拆掉记录，与我们建的目录文件）
 *   node tools/connect.mjs verify <客户端> [--model <id>]  静态读回 + 拿配置里的令牌真打一次桥
 *
 * `native` 与 `undo` 的区别：前者是**换挡**（记录、目录文件都留着，随时切回桥），
 * 后者是**拆掉**（记录归档、目录文件删除，再想用桥得重新接入）。
 *
 * 与控制台的「一键接入」是**同一套实现**（`lib/client-connect.mjs`），
 * 备份、幂等、撤销的行为完全一致 —— 不存在"命令行写的"和"控制台写的"两份不同结果。
 *
 * 为什么要有它：控制台要开浏览器；而在 SSH / 脚本 / 别人替你装的场景里，
 * 一条命令才是真的"无脑"。两边入口不同、内核相同，改行为只改 lib 那一份。
 */
import {
  CONNECT_CLIENTS,
  applyClient,
  assertModelKnown,
  assertModelsKnown,
  buildConnectBase,
  contextForClient,
  findClient,
  planClient,
  recordedConnect,
  resolveBackupRoot,
  resolveModelChoice,
  resolveSelection,
  switchClientMode,
  undoClient,
  verifyAgainstBridge,
  verifyWritten,
} from '../lib/client-connect.mjs';

const argv = process.argv.slice(2);
const command = argv[0] || 'status';
// 客户端 id 与 --model / --models 可混排；两种写法都支持（`--model <id>` / `--model=<id>`）。
let target = '';
let chosenModel = null;
let chosenModels = null;
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--model') { chosenModel = argv[++i] || null; continue; }
  if (a.startsWith('--model=')) { chosenModel = a.slice('--model='.length) || null; continue; }
  if (a === '--models') { chosenModels = splitModels(argv[++i]); continue; }
  if (a.startsWith('--models=')) { chosenModels = splitModels(a.slice('--models='.length)); continue; }
  if (!target && !a.startsWith('--')) target = a;
}

/** `--models a,b,c` → `['a','b','c']`；空串 / 没给 → `null`（= 用默认或文件里现有那批）。 */
function splitModels(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

// 上下文构造（桥地址、令牌、模型清单、各客户端默认模型）与校验都在
// `lib/client-connect.mjs`：buildConnectBase / contextForClient / assertModelKnown，
// 与控制台 `dashboard/server.mjs` 完全同源，不再各持一份。

/**
 * 把「新值」变成能看的一行。对象（opencode 的 provider 块）不整段打出来 ——
 * 那会有几十行，`status` 会没法扫；只说"新增了一块配置"，细节用 `verify` / 控制台看。
 */
const showValue = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return '(一整块配置，见下方说明)';
  return String(v);
};

const describe = (c) => {
  if (c.kind === 'section') return `  ${c.path}  ${c.from ? '(替换已有的节)' : '(新增节)'}`;
  if (c.from === null || c.from === undefined) return `  ${c.path}  (新增 ${showValue(c.to)})`;
  return `  ${c.path}: ${showValue(c.from)} -> ${showValue(c.to)}`;
};

async function main() {
  if (command === 'status') {
    const base = await buildConnectBase();
    for (const def of CONNECT_CLIENTS) {
      // 没指定 --model / --models 时认配置文件里现在那批（与控制台同一套口径）
      const selection = resolveSelection(base, def, chosenModels);
      const context = contextForClient(base, def.id, resolveModelChoice(base, def, chosenModel), selection);
      const plan = planClient(def.id, context);
      console.log(`\n${def.label}  ${plan.path}`);
      // 路径是怎么定下来的，如实说出来（别人机器上可能设着 CODEX_HOME / CLAUDE_CONFIG_DIR）
      const src = plan.pathSource || {};
      if (src.source === 'env') console.log(`  路径来源: 由 ${src.envName} 指定`);
      else if (src.source === 'client') console.log(`  路径来源: 跟随客户端的 ${src.envName}`);
      console.log(`  状态: ${plan.applied ? '已接入' : (plan.installed ? '已安装，尚未接入' : '未检测到该客户端')}${plan.e2e ? '' : '  [本机未实测]'}`);
      console.log(`  接入模型: ${context.models.map((m) => m.id).join(', ')}（默认 ${context.model}；--models a,b,c 可指定多个）`);
      if (context.models.length > 1 && def.id === 'codex') {
        console.log(plan.catalog ? `  模型目录: ${plan.catalog.path}` : `  模型目录: 不写（${plan.catalogSkipped || '未知原因'}）`);
      }
      if (plan.error) console.log(`  读取失败: ${plan.error}`);
      else if (!plan.changes.length) console.log('  将改动: 无（已经是接入状态）');
      else {
        console.log('  将改动:');
        for (const c of plan.changes) console.log(describe(c));
      }
    }
    console.log(`\n备份目录: ${resolveBackupRoot()}`);
    if (!base.running) console.log('（桥未运行：写入仍可执行，但 verify 会失败）');
    return;
  }

  if (command === 'apply' || command === 'undo' || command === 'native' || command === 'bridge' || command === 'profile') {
    /*
     * `profile <客户端>` = 写那个客户端的 **profile 文件**（目前只有 Codex 有这条路，
     * 见 `CONNECT_CLIENTS` 里 `codex-profile` 的说明）。与 `apply` 的区别只有一个：
     * **基础配置一个字节都不动**，用户用 `codex -p workbuddy` 启动。
     * 所以它复用 apply 的全部逻辑，只是目标换成了 profile 那份文件。
     */
    const resolved = command === 'profile' && target ? `${target}-profile` : target;
    const client = findClient(resolved);
    if (!client) {
      console.error(`不认识的客户端：${target}。可选：${CONNECT_CLIENTS.map((c) => c.id).join(' / ')}`);
      process.exit(1);
    }
    if (command === 'profile' && !client.profileFor) {
      console.error(`${target} 没有 profile 通道（目前只有 Codex 有：codex -p <name>）。`);
      process.exit(1);
    }
    /*
     * 模式切换。`native` **不碰网络**：它只是按记录把我们接管过的键还原，
     * 桥没起、令牌已经失效都不影响 —— 而那恰恰是用户最需要它的时刻
     * （"我暂时不想走桥了"）。所以它必须在 `buildConnectBase()` 之前就返回。
     */
    if (command === 'native' || command === 'bridge') {
      let r;
      if (command === 'native') {
        r = switchClientMode(resolved, 'native');
      } else {
        const base = await buildConnectBase();
        // 沿用记录里上次接的那批：用户不必重新勾一遍；显式给了就以显式为准
        const rec = recordedConnect(resolved);
        const chosen = resolveModelChoice(base, client, chosenModel || rec.model);
        const selection = resolveSelection(base, client, chosenModels || rec.models);
        const bad = assertModelKnown(chosen, base) || assertModelsKnown(selection, base);
        if (bad) { console.error(bad); process.exit(1); }
        r = switchClientMode(resolved, 'bridge', contextForClient(base, resolved, chosen, selection));
      }
      if (!r.ok) { console.error(`切换失败：${r.error}`); process.exit(1); }
      console.log(r.changed
        ? (command === 'native' ? '已切回客户端自己的模型。' : '已切回桥的模型。')
        : (r.message || '无需改动。'));
      if (r.backup) console.log(`原文件已备份到：${r.backup}`);
      if (r.backupHardened && r.backupHardened.ok === false) {
        console.error(`警告：备份目录的权限没能收紧（${r.backupHardened.reason || ''}）`);
        console.error('  → 备份是"写之前的整份配置"，从第二次写入起里面就有令牌；同机其它用户可能读到它。');
      }
      if (r.verify && !r.verify.ok) console.error(`静态自检未通过：${r.verify.reason || ''}`);
      if (r.auth) {
        console.log(r.auth.ok
          ? `端到端验证通过：拿配置里的令牌连上了桥（${r.auth.models} 个模型）。`
          : `端到端验证没通过：${r.auth.reason || ''}`);
        if (!r.auth.ok) process.exit(2);
      }
      if (r.catalog && r.catalog.kept) {
        console.log(`模型目录文件保留在：${r.catalog.path}`);
        console.log('  （它已不再被引用；切回桥时可直接复用。想连文件一起清掉就用 undo）');
      }
      return;
    }

    const base = await buildConnectBase();

    // `profile` 与 `apply` 是同一套写入流程，只是目标换成了 profile 文件
    if (command === 'apply' || command === 'profile') {
      // 没指定就沿用文件里那批：否则「重新写入」会把用户自己的选择改掉
      const chosen = resolveModelChoice(base, client, chosenModel);
      const selection = resolveSelection(base, client, chosenModels);
      const badModel = assertModelKnown(chosen, base) || assertModelsKnown(selection, base);
      if (badModel) { console.error(badModel); process.exit(1); }
      const context = contextForClient(base, resolved, chosen, selection);
      console.log(`接入模型: ${context.models.map((m) => m.id).join(', ')}（默认 ${context.model}）`);
      // 与控制台同一套确认流程：把要改什么摆出来，再动手
      const plan = planClient(resolved, context);
      if (plan.error) { console.error(plan.error); process.exit(1); }
      /*
       * 「无需改动」要**连目录一起看**：`model_catalog_json` 早就写对时 config 一个字都不用改，
       * 但那份目录可能正是旧版本写坏的（code mode 开关）。只看 `changes` 就返回，
       * 目录永远纠正不过来 —— 实测在真机上踩到过。
       */
      const catalogWork = plan.catalog && ((plan.catalog.added || []).length || (plan.catalog.refreshed || []).length);
      if (!plan.changes.length && !catalogWork) { console.log('已经是接入状态，无需改动。'); return; }
      if (plan.changes.length) {
        console.log(`将修改 ${plan.path}：`);
        for (const c of plan.changes) console.log(describe(c));
        if (plan.reformats) console.log('注意：该文件会被重新排版为 2 空格缩进。');
      } else {
        console.log(`配置无需改动；只重写模型目录：${plan.catalog.path}`);
        if (plan.catalog.refreshed.length) console.log(`  （纠正旧条目 ${plan.catalog.refreshed.length} 个：${plan.catalog.refreshed.join(', ')}）`);
      }
      console.log('');

      const r = applyClient(resolved, context);
      if (!r.ok) { console.error(`写入失败：${r.error}`); process.exit(1); }
      if (!r.changed) { console.log('没有改动 —— 已经是接入状态。'); return; }
      console.log('已写入。');
      if (r.backup) console.log(`原文件已备份到：${r.backup}`);
      /*
       * profile 通道要把「怎么用」说出来 —— 用户照着敲的那一句 + 一个必须知道的限制。
       * 不说的话，他写完了却不知道下一步该干什么（而桌面应用又不吃这个开关）。
       */
      if (client.profileFor) {
        console.log('');
        console.log(`用 ${client.profileName} 这个 profile 启动即可：`);
        console.log(`  codex -p ${client.profileName}`);
        console.log(`（你的 ${client.profileFor === 'codex' ? 'config.toml' : '基础配置'} 一个字节都没动；`
          + `不想要了就删掉这个文件，或执行 connect undo ${resolved}）`);
        console.log('注意：桌面应用不接受命令行开关，这条通道只对命令行生效。');
      }
      if (r.backupHardened && r.backupHardened.ok === false) {
        console.error(`警告：备份目录的权限没能收紧（${r.backupHardened.reason || ''}）`);
        console.error('  → 备份是"写之前的整份配置"，从第二次写入起里面就有令牌；同机其它用户可能读到它。');
      }
      /*
       * 被跳过的键要说出来。`"env": []` 这类中间层是用户自己的数据，我们**不覆盖**它，
       * 于是那几个键没写进去 —— 只报"已写入"等于骗人：下次请求失败时，
       * 用户根本想不到是这里。
       */
      if (r.skippedKeys && r.skippedKeys.length) {
        console.error('警告：以下键没能写入（它们所在的上级不是对象，是你的数据，没敢覆盖）：');
        for (const k of r.skippedKeys) console.error(`  · ${k}`);
        console.error('  → 该文件里那一段是被写坏的（比如 "env": [] 少了内容）。');
        console.error('  → 改成一个对象（例如 "env": {}）后重新执行本命令即可。');
      }
      if (r.models && r.models.length > 1) console.log(`接入模型（${r.models.length} 个）：${r.models.join(', ')}`);
      if (r.catalog) {
        const parts = [`新增 ${r.catalog.added.length} 个`, `保留原有 ${r.catalog.kept} 个`];
        if ((r.catalog.refreshed || []).length) parts.push(`纠正旧条目 ${r.catalog.refreshed.length} 个`);
        console.log(`模型目录：${r.catalog.path}（${parts.join('，')}）`);
      } else if (r.catalogSkipped) console.log(`模型目录：不写 —— ${r.catalogSkipped}`);
      if (r.reformats) console.log('该文件被重新排版为 2 空格缩进。');
      if (r.hardened && r.hardened.ok === false) {
        console.error(`警告：令牌文件的权限没能收紧 —— ${r.hardened.reason || ''}`);
      }
      if (r.verify) {
        console.log(r.verify.ok ? '静态自检通过：配置里的键都在。' : `静态自检未通过：${r.verify.reason || ''}`);
      }
      const auth = await verifyAgainstBridge(client, { baseUrl: context.baseUrlOpenAI, tokenOverride: context.token });
      console.log(auth.ok
        ? `端到端验证通过：拿配置里的令牌连上了桥（${auth.models} 个模型）。`
        : `端到端验证没通过：${auth.reason || ''}`);
      if (!auth.ok) process.exit(2);
      return;
    }

    const r = undoClient(resolved);
    if (!r.ok) { console.error(`撤销失败：${r.error}`); process.exit(1); }
    console.log(r.removed
      ? `已撤销（该文件原本不存在，已一并删除）：${r.path}`
      : `已撤销：${r.path}`);
    if (r.backup) console.log(`当时的原始备份还在：${r.backup}`);
    /*
     * 目录文件没删掉要说。实测它在 Windows 上会被杀毒实时扫描短暂占用而删不掉
     * （`rmSync` 抛 EBUSY），而撤销照样报成功 —— 不说的话用户只能自己 `ls` 才发现。
     */
    if (r.catalog && r.catalog.error) {
      console.error(`警告：模型目录文件没能删掉：${r.catalog.path}（${r.catalog.error}）`);
      console.error('  → 它已经不被任何配置引用了，手动删掉即可。');
    }
    return;
  }

  if (command === 'verify') {
    const client = findClient(target);
    if (!client) {
      console.error(`不认识的客户端：${target}。可选：${CONNECT_CLIENTS.map((c) => c.id).join(' / ')}`);
      process.exit(1);
    }
    const base = await buildConnectBase();
    // 验证要用与写入同一批模型，否则静态读回会拿别的集合去比，报出假的"未通过"
    const chosen = resolveModelChoice(base, client, chosenModel);
    const selection = resolveSelection(base, client, chosenModels);
    const badModel = assertModelKnown(chosen, base) || assertModelsKnown(selection, base);
    if (badModel) { console.error(badModel); process.exit(1); }
    const context = contextForClient(base, target, chosen, selection);
    const written = verifyWritten(client, context);
    if (!written.ok) { console.error(`静态自检未通过：${written.reason || ''}`); process.exit(1); }
    console.log('静态自检通过：配置里的键都在。');
    const auth = await verifyAgainstBridge(client, { baseUrl: context.baseUrlOpenAI, tokenOverride: context.token });
    if (!auth.ok) { console.error(`端到端验证没通过：${auth.reason || ''}`); process.exit(2); }
    console.log(`端到端验证通过：拿配置里的令牌连上了桥（${auth.models} 个模型）。`);
    return;
  }

  console.error('用法：node tools/connect.mjs [status | apply <客户端> [--model <id>] [--models a,b,c] | profile <客户端>（写 profile 文件，不动基础配置） | native <客户端> | bridge <客户端> [--model <id>] [--models a,b,c] | undo <客户端> | verify <客户端> [--model <id>] [--models a,b,c]]');
  console.error(`客户端：${CONNECT_CLIENTS.map((c) => c.id).join(' / ')}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
