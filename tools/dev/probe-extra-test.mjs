/**
 * 开发期验证：find-workbuddy 的分层探测（静态 / 扫描 / 系统信号兜底）。
 *
 *   node tools/dev/probe-extra-test.mjs
 *
 * 直接调 lib 的真实现（桥内联的同款算法在 bridge/workbuddy-bridge.mjs）。
 * 最后一项用 fixture 验证"卸载器 / 图标 / 协议"形态的提取逻辑。
 */
import {
  extractExePathsFromSignals,
  findWorkBuddyExe,
  probeSystemSignalsExe,
  scanForWorkBuddyExe,
  staticWorkBuddyExeCandidates,
} from '../../lib/find-workbuddy.mjs';

const line = (k, v) => console.log(String(k).padEnd(12), v);

const statics = staticWorkBuddyExeCandidates();
line('静态候选数', statics.length);

const t1 = Date.now();
const scanned = scanForWorkBuddyExe();
line('扫描命中', JSON.stringify(scanned));
line('扫描耗时', `${Date.now() - t1}ms`);

const t2 = Date.now();
const sys = probeSystemSignalsExe();
line('系统信号', JSON.stringify(sys));
line('信号耗时', `${Date.now() - t2}ms`);

line('最终定位', findWorkBuddyExe());

// ── fixture：提取逻辑（覆盖注册表里三种真实形态）────────────────────────
const fixture = {
  procs: ['E:\\App\\WorkbuddyInternational\\WorkBuddy.exe'],
  reg: [
    { icon: 'E:\\App\\WorkbuddyInternational\\WorkBuddy.exe,0' },
    { uninst: '"E:\\App\\WorkBuddy\\Uninstall WorkBuddyAI.exe" /currentuser' },
    { cmd: '"E:\\App\\WorkbuddyInternational\\WorkBuddy.exe" "%1"' },
    { uninst: '"C:\\Nowhere\\Uninstall.exe" /currentuser' }, // 无关：目录里没有客户端
  ],
};
const extracted = extractExePathsFromSignals(fixture);
line('fixture提取', JSON.stringify(extracted));
const expected = [
  'E:\\App\\WorkbuddyInternational\\WorkBuddy.exe',
  'E:\\App\\WorkBuddy\\WorkBuddyAI.exe',
];
const ok = expected.every((p) => extracted.includes(p)) && extracted.length === expected.length;
console.log(ok ? '✔ fixture 断言通过（图标/协议直认 + 卸载器目录回退 + 无关项忽略）' : `✘ fixture 断言失败：${JSON.stringify(extracted)}`);
process.exit(ok ? 0 : 1);
