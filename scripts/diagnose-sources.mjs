import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { diagnoseSources } from '../src/audit/diagnostics.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const controller = new AbortController();
const stop = () => { if (!controller.signal.aborted) { console.log('Останавливаем диагностику…'); controller.abort(); } };
process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGBREAK', stop);
try {
  console.log('Короткая диагностика: до 45 секунд. Нет установки, выгрузки районов или изменения кэша.');
  const report = await diagnoseSources({ signal: controller.signal });
  const output = join(root, 'outputs', `source-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'sources.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(join(output, 'README.txt'), 'Диагностика доступа, не поиск клиентов.\n' + report.checks.map(x => `${x.name}: ${x.status}; ${x.http || x.code || ''}; ${x.url || ''}`).join('\n') + '\nПодробности в sources.json. Старые результаты и кэш не изменены.\n', 'utf8');
  console.log(`Готово: ${output}\\sources.json\nЭто проверка соединения, а не подтверждение работоспособности поиска клиентов.`);
  process.exitCode = controller.signal.aborted ? 130 : report.status === 'complete' ? 0 : 2;
} catch (error) { console.error(`Ошибка диагностики: ${error.message}`); process.exitCode = 1; }
finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('SIGBREAK', stop); }
