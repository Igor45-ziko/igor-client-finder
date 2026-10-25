// Synthetic LOCAL processes only. No company data and no network requests.
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
const [mode, ready, heartbeat] = process.argv.slice(2);
if (mode === 'worker') {
  setInterval(() => appendFileSync(heartbeat, '.'), 50);
  process.on('SIGTERM', () => {});
  console.log('synthetic worker ready');
} else {
  const worker = spawn(process.execPath, [import.meta.filename, 'worker', ready, heartbeat], { stdio: 'inherit' });
  writeFileSync(ready, JSON.stringify({ parent: process.pid, worker: worker.pid }));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
