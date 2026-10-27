import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compactReport } from './prospects.mjs';

// Pure reformatting: no network, browser, dependencies, or writes to old results/cache.
export async function reformatSavedReport(root) {
  const dirs = (await readdir(join(root, 'outputs'), { withFileTypes: true }).catch(() => []))
    .filter(d => d.isDirectory() && d.name.startsWith('base-audit-')).sort((a, b) => b.name.localeCompare(a.name));
  const skipped = [];
  for (const dir of dirs) {
    const previous = join(root, 'outputs', dir.name); let results, report;
    try {
      results = JSON.parse(await readFile(join(previous, 'audit.json'), 'utf8'));
      report = JSON.parse(await readFile(join(previous, 'report.json'), 'utf8'));
      if (!Array.isArray(results) || !results.length || results.some(r => !r?.row || !Array.isArray(r.row.sources) || !Array.isArray(r.checks) || !r.discovery || !r.decision)) throw Error('format');
    } catch { skipped.push(dir.name); continue; }
    const output = join(root, 'outputs', `brief-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'report.html'), compactReport({ ...report, errors: [...(report.errors || []), ...skipped.map(s => 'Пропущен нечитаемый отчёт: ' + s)] }, results, { detailsUrl: null }));
    await writeFile(join(output, 'origin.json'), JSON.stringify({ sourceReport: previous, createdAt: new Date().toISOString(), count: results.length, mode: 'offline_reformat', skipped }, null, 2));
    return { output, count: results.length, sourceReport: previous };
  }
  throw Error('Не найден непустой сохранённый audit.json от audit-base.cmd. Повторный поиск автоматически не запускается.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--help')) console.log('report-base.cmd: короткий отчёт из последнего audit.json, без сети и повторного аудита.');
    else { const result = await reformatSavedReport(resolve(dirname(fileURLToPath(import.meta.url)), '../..')); console.log(`Сохранено ${result.count} записей: ${join(result.output, 'report.html')}\nНового поиска и проверки сайтов не было. Источник: ${result.sourceReport}`); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
