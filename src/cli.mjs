import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './config.mjs';
import { run } from './run.mjs';

const help = `Игорь — поиск организаций, версия 0.1

Запуск в Windows 11: npm.cmd start
Нужен Node.js 24.5+ (ветка 24 LTS). Установка npm-пакетов и API-ключи не нужны.

Параметры:
  --cities "Тверь,Тула,Рязань"   Зоны поиска (по умолчанию все три)
  --target 20                   До 20 предварительных кандидатов
  --refresh                     Обновить кэш (не отменяет паузы и блокировки)
  --help                        Показать справку

Небольшое испытание: npm.cmd start -- --cities Тверь --target 5
Результаты: outputs/<дата-запуска>/leads.csv и report.json.
Источник: OpenStreetMap через Overpass API; © OpenStreetMap contributors, ODbL.
Нет автоматических сообщений. Отсутствие сайта в OSM не доказывает отсутствие сайта.
`;

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 5) throw new Error('Установите Node.js 24 LTS версии 24.5 или новее из ветки 24: https://nodejs.org/');
  const options = parseArgs(process.argv.slice(2));
  if (options.help) console.log(help);
  else {
    const controller = new AbortController();
    const stop = () => { console.log('\nОстановка: сохраняю уже полученные результаты…'); controller.abort(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    try {
      const result = await run({ root, ...options, signal: controller.signal });
      process.exitCode = controller.signal.aborted ? 130 : result.exitCode;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
} catch (error) {
  console.error(`Ошибка: ${error.message}`);
  process.exitCode = 1;
}
