/** Compare sync spawn strategies for the WorkBuddy key fetch, both plain and inside a live HTTP server. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const EXE = 'E:\\App\\WorkBuddy\\WorkBuddy.exe';
const SCRIPT =
  "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
  + 'catch(e){process.exitCode=3;process.stderr.write(String((e&&e.message)||e))}';
const ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

function tryExecFileSync() {
  try {
    const out = execFileSync(EXE, ['-e', SCRIPT], {
      env: ENV, timeout: 20000, windowsHide: true, encoding: 'utf8', maxBuffer: 1048576,
    });
    return `OK len=${out.length}`;
  } catch (e) {
    return `FAIL ${e.code || ''} ${String(e.message).slice(0, 70)}`;
  }
}

function trySpawnSyncIgnore() {
  const r = spawnSync(EXE, ['-e', SCRIPT], {
    env: ENV, timeout: 20000, windowsHide: true, encoding: 'utf8', maxBuffer: 1048576,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) return `FAIL ${r.error.code || ''} ${String(r.error.message).slice(0, 70)}`;
  return `status=${r.status} len=${r.stdout ? r.stdout.length : 0} err=${(r.stderr || '').slice(0, 40)}`;
}

console.log('[plain] execFileSync      :', tryExecFileSync());
console.log('[plain] spawnSync ignore  :', trySpawnSyncIgnore());

const server = createServer((req, res) => {
  console.log('[server] execFileSync     :', tryExecFileSync());
  console.log('[server] spawnSync ignore :', trySpawnSyncIgnore());
  res.end('done');
});
server.listen(8791, '127.0.0.1', () => {
  fetch('http://127.0.0.1:8791/')
    .then((r) => r.text())
    .then(() => server.close());
});
