import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ATTRIBUTION, CITIES, ENDPOINT, queryFor } from './config.mjs';
import { makeClient, SearchError, writeJson } from './network.mjs';
import { normalizeElement, deduplicate, selectLeads, toCsv, classify } from './model.mjs';

async function acquireLock(cacheDir) {
  const path = join(cacheDir, 'run.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx');
      await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await file.close();
      return () => unlink(path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await readFile(path, 'utf8')); }
      catch { throw new SearchError('LOCKED', 'Найден файл блокировки .cache/run.lock. Убедитесь, что другой поиск не запущен; подробности в README.'); }
      if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw new SearchError('LOCKED', 'Некорректный файл блокировки; подробности в README.');
      try { process.kill(previous.pid, 0); }
      catch (check) {
        if (check.code === 'ESRCH') { await unlink(path); continue; }
      }
      throw new SearchError('LOCKED', 'Другой экземпляр поиска уже работает. Дождитесь его завершения.');
    }
  }
  throw new SearchError('LOCKED', 'Не удалось получить блокировку запуска.');
}

function summaryText(report) {
  return [
    'Поиск автосервисов — предварительные кандидаты, не подтверждённые покупатели',
    `Статус: ${report.status}; начало UTC: ${report.startedAt}; окончание UTC: ${report.finishedAt}`,
    `Получено объектов: ${report.rawCount}; после фильтра и удаления дублей: ${report.organizations}; объединено дублей: ${report.duplicatesMerged}.`,
    `Предварительных кандидатов: ${report.leads} из желаемых ${report.target}.`,
    ...report.cities.map(city => `${city.name}: ${city.status}${city.rawCount !== undefined ? `, объектов ${city.rawCount}` : ''}${city.fromCache ? ', из кэша' : ''}${city.message ? ` — ${city.message}` : ''}`),
    '',
    report.leads < report.target ? 'Цель не достигнута. Данные не дополнены выдуманными организациями или контактами.' : 'Достигнут лимит предварительной выборки. Результаты требуют подтверждения.',
    report.status !== 'complete' ? 'Поиск НЕ завершён полностью. Нулевой результат при ошибке не означает отсутствие организаций.' : 'Все запрошенные зоны обработаны. Данные OSM могут быть неполными и устаревшими.',
    '',
    'leads.csv — до 20 организаций с названием, распознанным контактом и без поля сайта в OSM.',
    'all-organizations.csv — все сохранённые организации, включая имеющие сайт.',
    'review.csv — остальные записи; это не только ошибки, но и резерв для будущего аудита.',
    'report.json — статус, запросы и счётчики; organizations.json — поля и источники для каждой записи.',
    '',
    'Отсутствие ссылки в OSM НЕ доказывает отсутствие сайта. Работа сайтов и принадлежность контактов не проверялись.',
    'Поиск охватывает круг вокруг каждого города и может включать окрестности. Город из адреса OSM хранится отдельно.',
    'Телефоны и email только прочитаны из открытых данных. Сообщения, заявки и звонки не отправлялись.',
    ATTRIBUTION,
  ].join('\n') + '\n';
}

export async function run({ root, cities = CITIES, target = 20, refresh = false,
  fetchImpl, clock = Date.now, sleep, log = console.log, signal, interval } = {}) {
  const cacheDir = join(root, '.cache');
  await mkdir(cacheDir, { recursive: true });
  const release = await acquireLock(cacheDir);
  try {
    const startedAt = new Date(clock()).toISOString();
    const report = { version: 1, status: 'running', startedAt, target, endpoint: ENDPOINT,
      attribution: ATTRIBUTION, dataLimitations: 'OSM only; no website audit or verification of business/contact ownership; circular search includes surroundings.',
      cities: [], rawCount: 0, organizations: 0, duplicatesMerged: 0, leads: 0 };
    const rows = [];
    const client = makeClient({ endpoint: ENDPOINT, cacheDir, fetchImpl, clock, sleep, log, signal, interval });
    let stop = false;
    for (const city of cities) {
      if (stop) { report.cities.push({ name: city.name, status: 'not_requested', message: 'Не запрашивался после остановки поиска.' }); continue; }
      const query = queryFor(city);
      log(`Поиск: ${city.name}, радиус ${city.radius / 1000} км…`);
      try {
        const result = await client.search(query, { refresh });
        const found = result.data.elements.map(x => normalizeElement(x, city, result.fetchedAt)).filter(Boolean);
        rows.push(...found);
        report.rawCount += result.data.elements.length;
        report.cities.push({ name: city.name, status: 'ok', query, radiusMeters: city.radius,
          rawCount: result.data.elements.length, acceptedBeforeDeduplication: found.length,
          fromCache: result.fromCache, fetchedAt: new Date(result.fetchedAt).toISOString(),
          osmBaseTimestamp: result.data.osm3s?.timestamp_osm_base ?? null });
        log(`${city.name}: получено ${result.data.elements.length}, сохранено ${found.length}${result.fromCache ? ' (кэш)' : ''}.`);
      } catch (error) {
        // Unexpected programming/filesystem errors must fail loudly rather than masquerade as a partial search.
        if (!(error instanceof SearchError)) throw error;
        report.cities.push({ name: city.name, status: 'error', query, code: error.code, message: error.message });
        log(`${city.name}: ${error.message}`);
        stop = error.stop;
      }
    }
    const organizations = deduplicate(rows);
    const leads = selectLeads(organizations, target);
    const selectedIds = new Set(leads.flatMap(row => row.sourceIds));
    const review = organizations.filter(row => !row.sourceIds.some(id => selectedIds.has(id)));
    report.organizations = organizations.length;
    report.duplicatesMerged = rows.length - organizations.length;
    report.leads = leads.length;
    report.otherOrganizations = review.length;
    report.totalEligible = organizations.filter(row => classify(row).eligible).length;
    const successful = report.cities.filter(city => city.status === 'ok').length;
    report.status = successful === cities.length ? 'complete' : successful ? 'partial' : 'failed';
    report.finishedAt = new Date(clock()).toISOString();
    const output = resolve(root, 'outputs', `${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    await mkdir(output, { recursive: true });
    // Every run has its own directory, including failures. Previous successful exports are retained.
    await writeFile(join(output, 'leads.csv'), toCsv(leads), 'utf8');
    await writeFile(join(output, 'all-organizations.csv'), toCsv(organizations), 'utf8');
    await writeFile(join(output, 'review.csv'), toCsv(review), 'utf8');
    await writeJson(join(output, 'organizations.json'), organizations);
    await writeJson(join(output, 'report.json'), report);
    await writeFile(join(output, 'README.txt'), summaryText(report), 'utf8');
    log(`\nСохранено: ${output}\nКандидатов: ${leads.length}/${target}. Статус: ${report.status}.`);
    if (report.status !== 'complete') log('Поиск неполный. Откройте README.txt и report.json; нули при ошибке не означают отсутствие компаний.');
    return { report, output, exitCode: report.status === 'complete' ? 0 : 2 };
  } finally { await release(); }
}
