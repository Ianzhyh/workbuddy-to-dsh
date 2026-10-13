// 分析所有已捕获的场景，输出实验矩阵（只读，不删任何东西）。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'E:\\tmp\\codex-mcp-probe\\captures';
const rows = [];
for (const id of readdirSync(ROOT).sort()) {
  const dir = join(ROOT, id);
  if (!existsSync(join(dir, 'request-01.json'))) continue;
  const stderr = existsSync(join(dir, 'codex-exec.stderr.txt')) ? readFileSync(join(dir, 'codex-exec.stderr.txt'), 'utf8') : '';
  const reqs = readdirSync(dir).filter((f) => /^request-\d+\.json$/.test(f)).sort();
  const per = reqs.map((f) => {
    const t = JSON.parse(readFileSync(join(dir, f), 'utf8')).tools || [];
    return { round: f.match(/\d+/)[0], count: t.length, names: t.map((x) => x.name || x.type) };
  });
  const startupFail = stderr.match(/MCP server startup failed server_name="([^"]+)" error=([^\n"]{0,60})/);
  const mcpInit = /Service initialized as client peer_info/.test(stderr);
  const srv = [...stderr.matchAll(/server_info: Some\(Implementation \{ name: "([^"]+)"/g)].map((m) => m[1]);
  rows.push({
    id,
    rounds: per.length,
    toolsRound1: per[0]?.count,
    names: per[0]?.names,
    perRound: per.map((p) => p.count),
    startupFail: startupFail ? `${startupFail[1]} → ${startupFail[2]}` : '',
    mcpPeerInit: srv.length ? srv.join(',') : (mcpInit ? 'yes' : ''),
    hasDemoInTools: reqs.some((f) => readFileSync(join(dir, f), 'utf8').includes('demo')),
    searchOut: (() => {
      for (const f of reqs) {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const it = (j.input || []).find?.((x) => x.type === 'tool_search_output');
        if (it) return `${it.tools.length} 个 namespace: ${it.tools.map((t) => t.name).join(',')}`;
      }
      return '';
    })(),
  });
}
writeFileSync(join(ROOT, 'matrix.json'), JSON.stringify(rows, null, 2));
for (const r of rows) {
  console.log([r.id, `轮=${r.rounds}`, `tools=${r.toolsRound1}`, r.startupFail ? `启动失败: ${r.startupFail}` : '启动成功', r.mcpPeerInit ? `peer=${r.mcpPeerInit}` : '', r.searchOut ? `search→${r.searchOut}` : ''].filter(Boolean).join(' | '));
}
