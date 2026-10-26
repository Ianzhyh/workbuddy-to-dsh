#!/usr/bin/env node
/**
 * 运行期数据备份 / 恢复（零依赖）。
 *
 *   node tools/backup.mjs                          # 备份到 ./workbuddy-backup-<时间>
 *   node tools/backup.mjs --out D:\backup          # 指定目录
 *   node tools/backup.mjs --restore D:\backup --yes
 *
 * 备份范围：state.json / usage.jsonl / quota-history.jsonl / media-tasks.json /
 * bridge-token / credentials/。**不含日志、对话和上游明文凭据**；插件凭据是
 * DPAPI + AES-GCM 信封，仍由当前 Windows 用户解锁。
 *
 * 恢复前请先停止桥和控制台；脚本会先把当前数据目录复制成
 * `<data>.pre-restore-<时间>`，再覆盖。
 */
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import config from '../config.mjs';

const DATA_FILES = ['state.json', 'usage.jsonl', 'quota-history.jsonl', 'media-tasks.json', 'bridge-token'];
const DATA_DIRS = ['credentials'];
const manifestName = 'manifest.json';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
};
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 逐文件复制（Windows 上 cpSync 在非 ASCII/空格路径会静默失败）。 */
function copyTree(src, dest) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) copyTree(join(src, entry), join(dest, entry));
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function backup(outArg) {
  const dataDir = config.paths.data;
  if (!existsSync(dataDir)) {
    return fail(`运行期数据目录不存在：${dataDir}（先启动一次桥/控制台）`);
  }
  const out = resolve(outArg || join(process.cwd(), `workbuddy-backup-${stamp()}`));
  mkdirSync(out, { recursive: true });
  const files = [];
  for (const name of DATA_FILES) {
    const src = join(dataDir, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(out, name));
    files.push({ name, sha256: sha256(src), bytes: statSync(src).size });
  }
  for (const name of DATA_DIRS) {
    const src = join(dataDir, name);
    if (!existsSync(src)) continue;
    copyTree(src, join(out, name));
    for (const entry of readdirSync(src)) {
      const file = join(src, entry);
      if (statSync(file).isFile()) files.push({ name: `${name}/${entry}`, sha256: sha256(file), bytes: statSync(file).size });
    }
  }
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    source: dataDir,
    version: JSON.parse(readFileSync(join(config.paths.root, 'package.json'), 'utf8')).version,
    files,
  };
  writeFileSync(join(out, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`✅ 已备份 ${files.length} 个文件到：${out}`);
  console.log('   含本地令牌与插件加密凭据，请按敏感文件保管；恢复前先停止桥/控制台。');
}

function restore(srcArg) {
  if (!srcArg) return fail('用法：node tools/backup.mjs --restore <备份目录> --yes');
  if (!flag('--yes')) return fail('恢复会覆盖运行期数据；确认后加 --yes，并先停止桥/控制台。');
  const src = resolve(srcArg);
  const manifestFile = join(src, manifestName);
  if (!existsSync(manifestFile)) return fail(`不是有效的备份目录（缺少 ${manifestName}）：${src}`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); }
  catch (e) { return fail(`备份清单损坏：${e.message}`); }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return fail('备份清单没有文件列表');
  }
  // 只认备份自己会产出的名字：不拿清单里的任意路径去读文件
  const known = (name) => DATA_FILES.includes(name) || /^credentials\/[^/\\]+$/.test(name);
  for (const file of manifest.files) {
    if (!known(file.name)) return fail(`备份清单含未知文件：${file.name}`);
    const local = join(src, file.name);
    if (!existsSync(local)) return fail(`备份缺文件：${file.name}`);
    if (sha256(local) !== file.sha256) return fail(`校验失败（文件被改过）：${file.name}`);
  }
  const dataDir = config.paths.data;
  const before = `${dataDir}.pre-restore-${stamp()}`;
  if (existsSync(dataDir)) copyTree(dataDir, before);
  mkdirSync(dataDir, { recursive: true });
  for (const name of DATA_FILES) {
    const local = join(src, name);
    if (existsSync(local)) {
      copyFileSync(local, join(dataDir, name));
      if (name === 'bridge-token') {
        try { chmodSync(join(dataDir, name), 0o600); } catch { /* Windows ACL 由插件另行收紧 */ }
      }
    }
  }
  for (const name of DATA_DIRS) {
    const local = join(src, name);
    if (existsSync(local)) copyTree(local, join(dataDir, name));
  }
  console.log(`✅ 已恢复 ${manifest.files?.length || 0} 个文件到：${dataDir}`);
  console.log(`   恢复前的数据保留在：${before}`);
  console.log('   现在可以重新启动桥/控制台；旧客户端令牌若未变化应可直接使用。');
}

console.log('WorkBuddy 运行期数据备份');
console.log(`数据目录：${config.paths.data}`);
if (flag('--restore')) restore(valueOf('--restore'));
else backup(valueOf('--out'));
