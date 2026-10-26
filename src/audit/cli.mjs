import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function auditArgs(args) {
  const options = { limit: 60, target: 20, overtureMode: 'cache' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') { options.input = args[++i]; if (!options.input) throw new Error('--input требует путь к organizations.json.'); }
    else if (args[i] === '--saved-base') options.savedBase = true;
    else if (args[i] === '--refresh-base') options.refreshBase = true;
    else if (args[i] === '--overture') {
      options.overtureMode = args[++i];
      if (!['cache', 'online', 'off'].includes(options.overtureMode)) throw new Error('--overture: cache, online или off.');
    }
    else if (['--limit', '--target'].includes(args[i])) {
      const key = args[i].slice(2); const value = args[++i];
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > (key === 'limit' ? 300 : 20)) throw new Error(`Недопустимое значение --${key}.`);
      options[key] = Number(value);
    } else if (args[i] === '--help') options.help = true;
    else throw new Error(`Неизвестный аргумент ${args[i]}.`);
  }
  if (options.refreshBase && !options.savedBase) throw new Error('--refresh-base используется только с --saved-base.');
  if (options.savedBase && (args.includes('--limit') || args.includes('--overture'))) throw new Error('--saved-base обрабатывает всю базу без Overture; --limit и --overture здесь не применяются.');
  return options;
}
export async function main(args = process.argv.slice(2)) {
  const options = auditArgs(args);
  if (options.help) { console.log('Вся сохранённая база: audit-base.cmd или npm.cmd run audit:base.\n--saved-base: все outputs/*/organizations.json, без Overture и нового поиска.\n--refresh-base: повторить проверки сайтов; иначе результаты переиспользуются до 24 часов.\nДо 45 с на сайт, 10 минут на сетевую часть; следующий запуск продолжает оставшееся.\nОбычный аудит: npm.cmd run audit -- --limit 5\nПо умолчанию используется последняя непустая выборка outputs.\n--input "outputs/.../organizations.json" — выбрать другую.\n--limit 1..300 (по умолчанию 60), --target 1..20 (по умолчанию 20).\n--overture cache|online|off: по умолчанию только кэш, без ожидания загрузки. Онлайн: до 60 с на процесс, общий бюджет источников 90 с + остановка.'); return; }
  const { runAudit } = await import('./run.mjs');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const controller = new AbortController(); const stop = () => {
    if (controller.signal.aborted) return;
    console.log('Отмена: останавливаем загрузчик и сохраняем текущие результаты. Новые запросы не запускаются…'); controller.abort();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGBREAK', stop);
  try {
    const runner = options.savedBase ? (await import('./saved-base.mjs')).runSavedBase : runAudit;
    const result = await runner({ root, ...options, signal: controller.signal }); process.exitCode = controller.signal.aborted ? 130 : result.exitCode;
  }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('SIGBREAK', stop); }
}
