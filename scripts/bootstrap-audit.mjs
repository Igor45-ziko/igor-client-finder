import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Установка завершилась с кодом ${code}; ограничения доступа не обходятся.`)));
});
try {
  const args = process.argv.slice(2); const setupOnly = args[0] === '--setup'; if (setupOnly) args.shift();
  if (args.includes('--help')) { const { main } = await import('../src/audit/cli.mjs'); await main(args); }
  else {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major !== 24 || minor < 5) throw new Error('Нужен Node.js 24 LTS версии 24.5 или новее.');
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    let installed = true;
    for (const name of ['playwright', 'robots-parser']) {
      const actual = await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8').then(JSON.parse, () => null);
      if (actual?.version !== packageJson.dependencies[name]) installed = false;
    }
    if (!installed) {
      const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
      console.log('Установка бесплатных библиотек Playwright и robots-parser по package-lock.json…');
      await run([npmCli, 'ci', '--no-audit', '--no-fund']);
    }
    // The saved-base mode writes inventory before trying the browser. A browser
    // failure must not prevent exporting existing contacts or trigger a download.
    if (args.includes('--saved-base') && !setupOnly) {
      const { main } = await import('../src/audit/cli.mjs'); await main(args);
    } else {
    const { launchBrowser } = await import('../src/audit/browser.mjs');
    try { const browser = await launchBrowser(); await browser.close(); }
    catch {
      console.log('Установка бесплатного Chromium для Playwright (однократно; несколько сотен МБ)…');
      await run([join(root, 'node_modules/playwright/cli.js'), 'install', 'chromium', '--only-shell']);
      const browser = await launchBrowser(); await browser.close();
    }
    if (setupOnly) console.log('Браузер готов. Запуск: npm.cmd run audit -- --limit 5');
    else { const { main } = await import('../src/audit/cli.mjs'); await main(args); }
    }
  }
} catch (error) { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; }
