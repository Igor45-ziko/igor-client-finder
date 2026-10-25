import { readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.name.endsWith('.mjs')) result.push(path);
  }
  return result;
}
if (process.argv.includes('--test')) {
  const tests = (await files(join(root, 'test'))).filter(p => p.endsWith('.test.mjs'));
  const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} else {
  for (const file of [...await files(join(root, 'src')), ...await files(join(root, 'scripts'))]) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
  if (!process.exitCode) console.log('Синтаксис всех модулей проверен.');
}
