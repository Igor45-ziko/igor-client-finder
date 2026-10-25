import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Only the PID/process group created by this run is targeted, never a process name.
// PyInstaller --onefile creates a bootloader AND a worker. Killing the bootloader
// alone leaves its worker holding stdout/stderr open on Windows.
export function terminateTree(pid, { platform = process.platform, spawnImpl = spawn, timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new Error('Нет PID для остановки загрузчика.'));
  if (platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') return Promise.reject(error); }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const tool = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawnImpl(tool, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    let done = false;
    const finish = error => {
      if (done) return; done = true; clearTimeout(timer); killer.unref();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      killer.kill('SIGKILL'); finish(new Error('taskkill не ответил за 5 секунд.'));
    }, timeoutMs);
    killer.once('error', error => finish(new Error(`Не удалось запустить taskkill: ${error.code || error.message}`)));
    killer.once('exit', code => finish(code === 0 ? null : new Error(`taskkill завершился с кодом ${code}; остановка дерева не подтверждена.`)));
  });
}
