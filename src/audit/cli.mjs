import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function auditArgs(args) {
  const options = { limit: 60, target: 20 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') { options.input = args[++i]; if (!options.input) throw new Error('--input требует путь к organizations.json.'); }
    else if (['--limit', '--target'].includes(args[i])) {
      const key = args[i].slice(2); const value = args[++i];
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > (key === 'limit' ? 300 : 20)) throw new Error(`Недопустимое значение --${key}.`);
      options[key] = Number(value);
    } else if (args[i] === '--help') options.help = true;
    else throw new Error(`Неизвестный аргумент ${args[i]}.`);
  }
  return options;
}
export async function main(args = process.argv.slice(2)) {
  const options = auditArgs(args);
  if (options.help) { console.log('npm.cmd run audit -- --limit 5\nПо умолчанию используется последняя непустая выборка outputs.\n--input "outputs/.../organizations.json" — выбрать другую.\n--limit 1..300 (по умолчанию 60), --target 1..20 (по умолчанию 20).'); return; }
  const { runAudit } = await import('./run.mjs');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const controller = new AbortController(); const stop = () => {
    if (controller.signal.aborted) return;
    console.log('Отмена: останавливаем загрузчик и сохраняем текущие результаты. Новые запросы не запускаются…'); controller.abort();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGBREAK', stop);
  try { const result = await runAudit({ root, ...options, signal: controller.signal }); process.exitCode = controller.signal.aborted ? 130 : result.exitCode; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('SIGBREAK', stop); }
}
