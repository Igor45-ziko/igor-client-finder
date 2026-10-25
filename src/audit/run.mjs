import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CITIES, ATTRIBUTION } from '../config.mjs';
import { acquireLock } from '../run.mjs';
import { readJson, writeJson } from '../network.mjs';
import { csvCell, classify } from '../model.mjs';
import { loadOverture, OVERTURE_ATTRIBUTION } from './overture.mjs';
import { discover } from './matching.mjs';
import { launchBrowser, createAuditor } from './browser.mjs';
import { CHANNELS, CHANNEL_LABELS, availableContacts, contactFields } from './contacts.mjs';

export const STATUS = {
  confirmed: 'Официальный сайт подтверждён совпадением данных',
  unverified: 'Сайт-кандидат найден, принадлежность не подтверждена',
  unavailable: 'Сайт-кандидат найден, проверка недоступна',
  not_found: 'Сайт не обнаружен, требуется подтверждение',
  incomplete: 'Поиск сайта не завершён: независимый источник недоступен',
  ambiguous: 'Несколько сайтов совпали; требуется ручная проверка',
};

export async function findInput(root, supplied) {
  if (supplied) return resolve(root, supplied);
  const base = join(root, 'outputs');
  const dirs = await readdir(base, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs.filter(x => x.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const path = join(base, dir.name, 'organizations.json');
    const data = await readJson(path);
    if (Array.isArray(data) && data.length) return path;
  }
  throw new Error('Не найдена сохранённая выборка. Сначала выполните npm.cmd start либо перенесите старую папку outputs в новую версию.');
}

export function validateRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000 || rows.some(r => !r || typeof r.name !== 'string' ||
      !Array.isArray(r.searchCities) || !Array.isArray(r.sources) || !Array.isArray(r.sourceIds) ||
      !Array.isArray(r.phones) || !Array.isArray(r.emails) || !Array.isArray(r.rawWebsites)))
    throw new Error('Ожидается organizations.json из поискового модуля, а не CSV или отчёт аудита.');
  return rows;
}

export function auditQueue(rows, limit) {
  const contact = r => availableContacts(r).length;
  const usable = rows.filter(r => r.name && contact(r) && !r.geoWarning);
  const missing = usable.filter(r => !r.rawWebsites.length).sort((a, b) => classify(b).score - classify(a).score);
  const listed = usable.filter(r => r.rawWebsites.length);
  const queue = [];
  // Both new-site and repair prospects get attention; don't consume the budget on only one group.
  while (queue.length < limit && (missing.length || listed.length)) {
    if (missing.length) queue.push(missing.shift());
    if (queue.length < limit && listed.length) queue.push(listed.shift());
  }
  return queue;
}

export function decide(discovery, checks) {
  const confirmed = checks.filter(x => x.status === 'confirmed');
  const domains = new Set(confirmed.map(x => new URL(x.finalUrl || x.candidate.url).hostname.replace(/^www\./, '')));
  if (domains.size > 1) return { code: 'ambiguous', priority: 0, best: null, reason: 'Нельзя автоматически выбрать один официальный сайт.' };
  if (confirmed.length) {
    const best = confirmed.sort((a, b) => b.issues.length - a.issues.length)[0];
    const weight = Math.min(15, best.issues.reduce((sum, x) => sum + x.weight, 0));
    return { code: 'confirmed', priority: weight ? 70 + weight : 0, best,
      reason: weight ? best.issues.map(x => x.label).join('; ') : 'Основные проверенные проблемы не обнаружены; предложение переделки не обосновано.' };
  }
  if (discovery.candidates.length) return { code: checks.some(x => x.status === 'unverified') ? 'unverified' : 'unavailable',
    priority: 0, best: checks[0] || null, reason: 'Есть адрес сайта, но данных для автоматического подтверждения недостаточно.' };
  if (discovery.unresolvedReferences?.length) return { code: 'unverified', priority: 0, best: null,
    reason: 'В источнике заполнено поле сайта, но адрес не удалось распознать. Нельзя считать это отсутствием сайта.' };
  if (discovery.independentStatus !== 'ok') return { code: 'incomplete', priority: 0, best: null,
    reason: 'Отсутствие результата при недоступном Overture нельзя считать завершённым поиском.' };
  return { code: 'not_found', priority: 30, best: null,
    reason: 'В Overture и доступных полях контактов сайт не обнаружен. Это ограниченный поиск, не доказательство отсутствия сайта.' };
}

export function resultNotes(r) {
  return {
    facts: r.checks.flatMap(c => c.pages || []).map(p => `${p.url}: HTTP ${p.http}`).concat(
      r.decision.best?.matched?.length ? ['Совпали: ' + r.decision.best.matched.join(', ')] : []).join(' | '),
    assumptions: r.decision.priority ? (r.decision.code === 'not_found' ? 'Возможно, полезна разработка сайта; наличие сайта, потребность и бюджет нужно подтвердить.' :
      'Возможно, полезно исправление выявленных проблем; интерес и бюджет не установлены.') : 'Автоматически обоснованного предложения услуги пока нет.',
    errors: [r.discovery.independentStatus !== 'ok' && 'Независимый поиск недоступен или неполон',
      ...r.checks.map(c => c.reason || c.contactCheck), r.untestedCandidates > 0 && `Не проверено адресов: ${r.untestedCandidates}`].filter(Boolean).join(' | '),
  };
}
export function auditCsv(results) {
  const header = ['Название', 'Зона поиска', ...CHANNELS.map(k => CHANNEL_LABELS[k]), 'Статус сайта', 'Сайт / кандидаты', 'Основания совпадения',
    'Проблемы и причина отбора', 'Подтверждённые наблюдения', 'Предположения', 'Ошибки и ограничения', 'Приоритет проверки', 'Независимый источник', 'Ссылки источника сайтов', 'Источники OSM', 'Доказательства', 'Дата проверки UTC'];
  return '\uFEFF' + [header, ...results.map(r => { const fields = contactFields(r.row, r.checks); const notes = resultNotes(r); return [r.row.name, r.row.searchCities.join(' | '),
    ...CHANNELS.map(k => fields[k]), STATUS[r.decision.code],
    r.decision.best?.finalUrl || r.discovery.candidates.map(x => x.url).join(' | '), r.decision.best?.matched?.join(', ') || '',
    r.decision.reason, notes.facts, notes.assumptions, notes.errors, r.decision.priority, r.discovery.matches.map(x => `Overture ${x.id}`).join(' | ') || r.discovery.independentStatus,
    [...new Set([r.discovery.sourceUrl, ...r.discovery.candidates.flatMap(c => c.sources.map(s => s.sourceUrl))].filter(Boolean))].join(' | '),
    r.row.sources.join(' | '), r.evidenceFile, r.checkedAt]; })].map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function htmlReport(report, results, shortlist) {
  const link = (url, label = url) => /^https?:\/\//i.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(label)}</a>` : esc(label);
  const cards = rows => rows.map(r => { const fields = contactFields(r.row, r.checks); const notes = resultNotes({ checks: [], ...r }); return `<article><h3>${esc(r.row.name)}</h3><p>${esc(STATUS[r.decision.code])}</p><p>${esc(r.decision.reason)}</p>
    <p>${CHANNELS.filter(k => fields[k]).map(k => `${CHANNEL_LABELS[k]}: ${esc(fields[k])}`).join('<br>')}</p>
    <p><strong>Наблюдения:</strong> ${esc(notes.facts || 'Подтверждённого содержимого сайта нет.')}</p>
    <p><strong>Предположения:</strong> ${esc(notes.assumptions)}</p>
    ${notes.errors ? `<p><strong>Ошибки/ограничения:</strong> ${esc(notes.errors)}</p>` : ''}
    <p>${r.discovery.candidates.map(c => `<a href="${esc(c.url)}" target="_blank" rel="noreferrer">${esc(c.url)}</a>`).join(' · ')}</p>
    <p><a href="${esc(r.evidenceFile)}">Подробные доказательства JSON</a></p>
    <p>Источники: ${r.row.sources.map(url => link(url, 'OSM')).join(' · ')} ${[...new Set([r.discovery.sourceUrl, ...r.discovery.candidates.flatMap(c => c.sources?.map(s => s.sourceUrl) || [])].filter(Boolean))].map(url => link(url, 'Overture — выпуск данных')).join(' · ')}</p>
    ${(r.decision.best?.screenshots || []).map(p => `<a href="screenshots/${esc(p)}"><img loading="lazy" src="screenshots/${esc(p)}" alt="Снимок проверенной страницы"></a>`).join('')}
    </article>`; }).join('');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Проверка потенциальных клиентов</title>
    <style>body{font:16px/1.6 system-ui;max-width:1050px;margin:auto;padding:24px;color:#182329;background:#f3f5f5}article{background:white;padding:20px;margin:20px 0;border:1px solid #d4dcdc;border-radius:12px;overflow-wrap:anywhere}img{max-width:46%;max-height:380px;vertical-align:top;margin:1%}a{color:#075b91}p{overflow-wrap:anywhere}</style>
    <h1>Кандидаты для ручного подтверждения</h1><p>Проверено ${report.checked} из ${report.totalInput}. В коротком списке ${shortlist.length}. Статус запуска: ${esc(report.status)}.</p>
    <p>Это помощь в отборе, не доказательство потребности в услуге. Ни одного сообщения не отправлено. Отсутствие найденного сайта не доказывает его отсутствие.</p>
    <h2>Источники</h2><ul>${report.sources.map(s => `<li>${esc(s.city)} — ${esc(s.status)}: ${esc(s.message || `${s.count} объектов, выпуск ${s.release}`)} ${s.sourceUrl ? link(s.sourceUrl, 'Открыть источник') : ''}</li>`).join('')}</ul>
    <h2>Короткий список</h2>${cards(shortlist) || '<p>Обоснованных кандидатов в пределах этой проверки пока нет.</p>'}
    <details><summary>Все проверенные организации</summary>${cards(results)}</details>
    <p>${esc(ATTRIBUTION)}</p><p>${esc(OVERTURE_ATTRIBUTION)}</p></html>`;
}

export async function runAudit({ root, input, limit = 60, target = 20, log = console.log, signal,
  provider = loadOverture, browserFactory = launchBrowser, auditorFactory = createAuditor, clock = Date.now } = {}) {
  const path = await findInput(root, input);
  const rows = validateRows(JSON.parse(await readFile(path, 'utf8')));
  const queue = auditQueue(rows, limit);
  if (!queue.length) throw new Error('В выборке нет организаций с названием и контактом для проверки.');
  const cache = join(root, '.cache'); await mkdir(cache, { recursive: true }); const release = await acquireLock(cache);
  let browser;
  try {
    const started = new Date(clock()).toISOString();
    const output = join(root, 'outputs', `audit-${started.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    const screenshots = join(output, 'screenshots'); const evidenceDir = join(output, 'evidence');
    await mkdir(screenshots, { recursive: true }); await mkdir(evidenceDir, { recursive: true });
    const consoleLog = log; let logBytes = 0, logFailed = false;
    log = message => {
      consoleLog(message);
      const line = `${new Date().toISOString()} ${message}\n`;
      if (logFailed || logBytes > 1024 * 1024) return;
      try { appendFileSync(join(output, 'diagnostics.log'), line, 'utf8'); logBytes += Buffer.byteLength(line); }
      catch { logFailed = true; consoleLog('Не удалось записать diagnostics.log; диагностика остаётся в окне.'); }
    };
    log(`Проверка версии 0.2.1. Исходная выборка: ${path}\nЖурнал: ${join(output, 'diagnostics.log')}`);
    const report = { version: 2, sourceInput: path, startedAt: started, totalInput: rows.length, queued: queue.length,
      checked: 0, status: 'running', sources: [], errors: [], scope: 'Overture + OSM URLs + corporate email domains; not an exhaustive Internet search.' };
    await writeJson(join(output, 'report.json'), report);
    const providers = new Map();
    let downloadsDisabled = false;
    for (const city of CITIES.filter(c => queue.some(row => row.searchCities.includes(c.name)))) {
      if (signal?.aborted) break;
      const data = downloadsDisabled ? { status: 'unavailable', message: 'Загрузка отключена: завершение предыдущего процесса не подтверждено.' } :
        await provider(city, { root, log, signal }); providers.set(city.name, data);
      if (data.cleanupFailed) downloadsDisabled = true;
      report.sources.push({ city: city.name, status: data.status, message: data.message, release: data.release,
        count: data.data?.features?.length, sourceUrl: data.sourceUrl, fetchedAt: data.fetchedAt, fromCache: data.fromCache });
      log(`${city.name}: Overture ${data.status}${data.message ? ' — ' + data.message : `, ${data.data.features.length} объектов`}.`);
      await writeJson(join(output, 'report.json'), report);
    }
    let audit;
    const results = [];
    for (let index = 0; index < queue.length; index++) {
      if (signal?.aborted) break;
      const row = queue[index]; log(`[${index + 1}/${queue.length}] ${row.name}`);
      const providerResults = row.searchCities.map(c => providers.get(c)).filter(Boolean);
      const merged = { status: providerResults.length && providerResults.every(x => x.status === 'ok') ? 'ok' : 'unavailable',
        data: { features: providerResults.flatMap(x => x.data?.features || []) },
        sourceUrl: providerResults.find(x => x.sourceUrl)?.sourceUrl, release: providerResults.find(x => x.release)?.release,
        fetchedAt: Math.min(...providerResults.filter(x => x.fetchedAt).map(x => x.fetchedAt)) };
      const discovery = discover(row, merged);
      const checks = [];
      // Bounded budget is explicit in the result; remaining addresses are not described as checked.
      for (const candidate of discovery.candidates.slice(0, 3)) {
        if (signal?.aborted) break;
        if (!browser) {
          try { browser = await browserFactory(); audit = auditorFactory({ browser }); }
          catch { report.errors.push('Браузер не запущен; выполните npm.cmd run setup:audit.'); break; }
        }
        checks.push(await audit(row, candidate, { outputDir: screenshots, slug: `org-${index + 1}-site-${checks.length + 1}`, signal }));
      }
      const result = { row, discovery, checks, decision: decide(discovery, checks), checkedAt: new Date(clock()).toISOString(),
        untestedCandidates: Math.max(0, discovery.candidates.length - checks.length), evidenceFile: `evidence/org-${index + 1}.json` };
      result.contacts = availableContacts(row, checks);
      result.notes = resultNotes(result);
      results.push(result); report.checked = results.length;
      await writeJson(join(evidenceDir, `org-${index + 1}.json`), result);
      // Checkpoint after every organization: a later interruption cannot erase prior evidence.
      await writeJson(join(output, 'audit.json'), results);
      await writeJson(join(output, 'report.json'), report);
      log(`  ${STATUS[result.decision.code]}`);
    }
    const shortlist = results.filter(r => r.decision.priority > 0).sort((a, b) => b.decision.priority - a.decision.priority).slice(0, target);
    report.status = signal?.aborted ? 'interrupted' : report.sources.some(x => x.status !== 'ok') || report.errors.length ||
      results.some(r => ['incomplete', 'unavailable'].includes(r.decision.code) || r.untestedCandidates) ? 'partial' : 'complete';
    report.finishedAt = new Date(clock()).toISOString(); report.shortlisted = shortlist.length; report.notProcessed = rows.length - results.length;
    report.confirmedSites = results.filter(r => r.decision.code === 'confirmed').length;
    report.needsReview = results.filter(r => !['confirmed', 'not_found'].includes(r.decision.code)).length;
    await writeJson(join(output, 'report.json'), report);
    await writeFile(join(output, 'audit.csv'), auditCsv(results), 'utf8');
    await writeFile(join(output, 'shortlist.csv'), auditCsv(shortlist), 'utf8');
    await writeFile(join(output, 'report.html'), htmlReport(report, results, shortlist), 'utf8');
    log(`\nПроверка сохранена: ${output}\nКороткий список: ${shortlist.length}. Статус: ${report.status}. Откройте report.html.`);
    return { output, report, results, shortlist, exitCode: report.status === 'complete' ? 0 : 2 };
  } finally { try { await browser?.close(); } finally { await release(); } }
}
