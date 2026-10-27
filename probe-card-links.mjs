// Experimental Windows trial. Not imported by production entry points.
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { MOSCOW_AREAS, ENDPOINT, ATTRIBUTION } from './src/config.mjs';
import { normalizeElement, deduplicate } from './src/model.mjs';
import { makeClient, writeJson } from './src/network.mjs';
import { sourceReferences } from './src/audit/prospects.mjs';
import { terminateTree } from './src/audit/process.mjs';

const self = fileURLToPath(import.meta.url);
const root = dirname(self);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const issueCodes = new Set(['overflow', 'home_404', 'contact_404', 'image_404', 'link_404']);

export function trialQuery(area) {
  if (!MOSCOW_AREAS.some(x => x.areaWikidata === area.areaWikidata)) throw new Error('UNKNOWN_AREA');
  return `[out:json][timeout:20][maxsize:4194304];
area["boundary"="administrative"]["admin_level"="4"]["wikidata"="${area.areaWikidata}"]->.region;
.region out count;
(
 nwr["shop"="car_repair"]["website"](area.region);
 nwr["shop"="car_repair"]["contact:website"](area.region);
 nwr["shop"="car_repair"][~"."~"yandex[.]|2gis[.]"](area.region);
);
out body center 20;`;
}

export function trialRows(data, area, fetchedAt) {
  const counts = data.elements.filter(x => x.type === 'count');
  if (counts.length !== 1 || counts[0].tags?.areas !== '1' || counts[0].tags?.total !== '1') throw new Error('AREA_NOT_RESOLVED');
  return deduplicate(data.elements.filter(x => x.type !== 'count').map(x => normalizeElement(x, area, fetchedAt)).filter(x => x?.name));
}

export function observedCards(row, checks = []) {
  // A link on a corporate website may point to another branch! Never call it verified.
  return sourceReferences({ row, checks }).filter(x => x.kind === 'directory');
}

export function trialStatus(checks) {
  const confirmed = checks.filter(x => x.status === 'confirmed');
  if (confirmed.length) {
    const issues = confirmed.flatMap(x => x.issues || []).filter(x => issueCodes.has(x.code));
    return issues.length ? 'На сопоставленном сайте наблюдались проблемы: ' + issues.map(x => x.label).join('; ')
      : 'Сайт сопоставлен с организацией. В проверенном объёме четыре вида проблем не обнаружены.';
  }
  return 'Статус сайта не установлен. Независимый поиск отсутствующего сайта не выполнен; ошибки доступа не считаются неисправностью.';
}

export function renderTrial(report) {
  const visible = report.results.filter(x => x.cards.length);
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Проверка способа получения карточек</title><style>body{font:18px/1.5 system-ui;max-width:850px;margin:30px auto;padding:15px}article{border-top:1px solid #ccc;padding:20px 0}a{overflow-wrap:anywhere}small{display:block}</style>
<h1>Найденные ссылки — ещё не подтверждённые карточки</h1>
<p>Это короткое испытание получения ссылок, не список готовых клиентов. Проверяем только небольшой срез двух административных регионов, не всё Подмосковье.</p>
<p>Организаций со ссылками: ${visible.length}. Независимый поиск отсутствующих сайтов не выполнен. Карточки автоматически не запрашивались.</p>
<p>Откройте найденную ссылку обычным браузером. Сверьте название и филиал по адресу/контакту на странице-источнике. Если требуется капча или вход — оставьте ссылку непроверенной. HTTP 200 сам по себе не подтверждает карточку.</p>
${visible.map(x => `<article><h2>${esc(x.row.name)}</h2>${x.cards.map(c => `<p><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.url)}</a><small>Карточка и филиал не проверены. Ссылка опубликована: ${c.evidence.map(e => `<a href="${esc(e.sourceUrl)}" target="_blank" rel="noopener noreferrer">источник</a>`).join(', ')}</small></p>`).join('')}<p>${esc(trialStatus(x.checks))}</p>${x.checks.filter(c => c.status === 'confirmed').map(c => `<p>Сайт: <a href="${esc(c.finalUrl || c.candidate.url)}" target="_blank" rel="noopener noreferrer">${esc(c.finalUrl || c.candidate.url)}</a></p>${(c.issues || []).filter(i => issueCodes.has(i.code)).map(i => `<p>${esc(i.label)}: <a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.url)}</a></p>`).join('')}`).join('')}</article>`).join('') || '<p>Подходящие прямые ссылки не получены. Метод на этой выборке не подтверждён.</p>'}
<details><summary>Диагностика</summary><ul>${report.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details><p>${esc(ATTRIBUTION)}</p></html>`;
}

async function worker(output) {
  const report = { mode: 'experimental_card_link_trial', startedAt: new Date().toISOString(), status: 'running', verifiedCards: 0, results: [], notes: [], sources: [] };
  const save = async () => {
    await writeJson(join(output, 'trial.json'), report);
    await writeFile(join(output, 'trial.html'), renderTrial(report));
  };
  await save();
  // Abort useful work before the supervisor's independent hard deadline.
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 220000);
  const cancel = () => controller.abort(); process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let browser;
  try {
    const { launchBrowser, createAuditor, publicUrl } = await import('./src/audit/browser.mjs');
    const { discover, isDirectory } = await import('./src/audit/matching.mjs');
    // Check existing browser BEFORE requesting source data. No installation here.
    browser = await launchBrowser();
    const auditor = createAuditor({ browser, guard: async raw => {
      // Also block redirects/embedded frames: no automated catalogue requests.
      if (isDirectory(raw)) throw new Error('UNSAFE_URL');
      return publicUrl(raw);
    } });
    const client = makeClient({ endpoint: ENDPOINT, cacheDir: join(output, 'trial-cache'), signal: controller.signal, log: console.log });
    const groups = [];
    for (const area of MOSCOW_AREAS) {
      controller.signal.throwIfAborted();
      console.log(`Небольшая выборка: ${area.name} (до 20 записей).`);
      try {
        const found = await client.search(trialQuery(area));
        const rows = trialRows(found.data, area, found.fetchedAt);
        groups.push(rows);
        report.sources.push({ area: area.name, fetchedAt: found.fetchedAt, records: rows.length });
      } catch (e) {
        report.notes.push(`${area.name}: ${e.code || e.name}. Данные не получены.`);
        await save();
        if (e.stop || controller.signal.aborted) throw e;
      }
    }
    // Round-robin between Moscow and oblast. Prefer already published card links.
    for (const rows of groups) rows.sort((a, b) => Number(observedCards(b).length > 0) - Number(observedCards(a).length > 0));
    const sample = [];
    for (let i = 0; i < 3; i++) for (const rows of groups) if (rows[i]) sample.push(rows[i]);
    for (const row of deduplicate(sample)) {
      controller.signal.throwIfAborted();
      console.log(`Проверка опубликованных ссылок: ${row.name}`);
      const checks = []; const result = { row, checks, cards: observedCards(row) };
      report.results.push(result); await save();
      const candidate = discover(row, { status: 'not_requested' }).candidates[0];
      if (candidate) checks.push(await auditor(row, candidate, { outputDir: output, slug: `site-${report.results.length}`, signal: controller.signal, timeoutMs: 25000 }));
      result.cards = observedCards(row, checks);
      await save();
    }
    report.status = 'awaiting_manual_card_verification';
    report.notes.push('Выборка ограничена шестью организациями. Только опубликованные прямые ссылки; URL карточек не конструируются. Принадлежность карточки филиалу и независимый поиск сайтов пока не проверены.');
  } catch (e) {
    report.status = 'incomplete';
    report.notes.push(`Испытание не завершено: ${e.code || e.name}. Если браузер/модули отсутствуют, используйте уже установленную рабочую версию 0.2.5; проба ничего не устанавливает.`);
  } finally {
    clearTimeout(timer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    report.finishedAt = new Date().toISOString(); await save();
    await browser?.close().catch(() => {});
  }
  const links = report.results.reduce((n, x) => n + x.cards.length, 0);
  console.log(`Ссылок получено: ${links}. Проверенных карточек: 0. ${links ? 'Найденные ссылки требуют сверки.' : 'Способ на этой выборке не подтверждён.'}`);
  return report.status === 'incomplete' ? 2 : 0;
}

async function supervisor() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Нужен Node.js 24 LTS, уже используемый версией 0.2.5.');
  const output = await mkdtemp(join(tmpdir(), 'igor-card-trial-'));
  console.log(`Диагностика: ${output}\nНе более четырёх минут плюс до шести секунд на остановку. Старые данные не изменяются.`);
  const child = spawn(process.execPath, ['--use-env-proxy', self, '--worker', output], { cwd: root, stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true });
  let stopped = false, finished = false;
  let end;
  const done = new Promise(resolve => { end = resolve; });
  const stop = async reason => {
    if (stopped || finished) return; stopped = true;
    const fallback = setTimeout(() => { child.unref(); end(2); }, 6000);
    try {
      await writeFile(join(output, 'interrupted.txt'), `${reason}\ntrial.json/trial.html may be incomplete. No card verification claimed.\n`);
      await terminateTree(child.pid);
    } catch { console.error('Остановка дерева процессов не подтверждена.'); }
    finally { clearTimeout(fallback); child.unref(); end(2); }
  };
  const timer = setTimeout(() => void stop('Hard timeout: 240 seconds'), 240000);
  const cancel = () => void stop('Cancelled by user');
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  child.once('error', () => end(2)); child.once('exit', code => { finished = true; end(stopped ? 2 : (code ?? 2)); });
  const code = await done; clearTimeout(timer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  console.log(`Откройте отчёт: ${join(output, 'trial.html')}\nДля разбора результата сохраните trial.json и interrupted.txt (если есть).`);
  // No shell interpolation and no contact actions. Local HTML only.
  if (process.platform === 'win32' && await readFile(join(output, 'trial.html')).then(() => true, () => false)) {
    const viewer = spawn('explorer.exe', [join(output, 'trial.html')], { stdio: 'ignore', detached: true, windowsHide: true });
    viewer.on('error', () => {}); viewer.unref();
  }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  if (process.argv[2] === '--help') console.log('Experimental probe: node --use-env-proxy probe-card-links.mjs. No installations; outputs/.cache/.tools remain untouched.');
  else {
    try { process.exitCode = process.argv[2] === '--worker' ? await worker(process.argv[3]) : await supervisor(); }
    catch { console.error('Не удалось запустить пробу. Проверьте Node.js 24 и доступ к временной папке.'); process.exitCode = 2; }
  }
}
