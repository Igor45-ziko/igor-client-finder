import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deduplicate } from '../model.mjs';
import { acquireLock } from '../run.mjs';
import { writeJson } from '../network.mjs';
import { validateRows, decide, resultNotes, auditCsv, htmlReport, STATUS } from './run.mjs';
import { discover } from './matching.mjs';
import { availableContacts } from './contacts.mjs';
import { launchBrowser, createAuditor } from './browser.mjs';

const fingerprint = row => createHash('sha256').update(JSON.stringify(row)).digest('hex');
const unavailableSource = { status: 'not_requested', data: { features: [] } };
const filesInOutputs = async root => (await readdir(join(root, 'outputs'), { withFileTypes: true }).catch(() => []))
  .filter(d => d.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));

// Newest snapshot of an OSM object wins; don't revive a removed website from an older search.
// Different objects are merged by the existing conservative branch-aware deduplicator.
export async function loadSavedBase(root, supplied) {
  const paths = supplied ? [resolve(root, supplied)] : (await filesInOutputs(root))
    .map(d => join(root, 'outputs', d.name, 'organizations.json'));
  const entries = [], inputs = [], warnings = [];
  for (const path of paths) {
    let text;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' && !supplied) continue; throw error; }
    let rows;
    try { rows = JSON.parse(text); if (Array.isArray(rows) && !rows.length) continue; validateRows(rows); }
    catch { warnings.push(`Не прочитан файл выборки: ${path}`); continue; }
    inputs.push({ path, records: rows.length });
    for (const row of rows) {
      const dates = (row.evidence || []).map(e => Date.parse(e.fetchedAt)).filter(Number.isFinite);
      entries.push({ row, path, date: dates.length ? Math.max(...dates) : 0 });
    }
  }
  if (!entries.length) throw new Error('В outputs нет непустой сохранённой базы organizations.json. Сохраните вашу прежнюю папку outputs при обновлении. Новый поиск автоматически не запускается.' + (warnings.length ? '\n' + warnings.join('\n') : ''));
  entries.sort((a, b) => b.date - a.date);
  const seen = new Set(), latest = [];
  for (const { row } of entries) {
    if (row.sourceIds.some(id => seen.has(id))) continue;
    latest.push(row); row.sourceIds.forEach(id => seen.add(id));
  }
  const rows = deduplicate(latest);
  if (rows.length > 10000) throw new Error('Сохранённая база превышает предел 10 000 записей. Выберите конкретную выборку через --input.');
  return { rows, inputs, warnings, readRecords: entries.length, duplicates: entries.length - rows.length };
}

async function previousChecks(root, now) {
  const saved = new Map();
  for (const dir of await filesInOutputs(root)) {
    if (!dir.name.startsWith('base-audit-')) continue;
    let rows;
    try { rows = JSON.parse(await readFile(join(root, 'outputs', dir.name, 'audit.json'), 'utf8')); }
    catch { continue; }
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (!r.row || !r.fingerprint || r.fingerprint !== fingerprint(r.row) || !Array.isArray(r.checks)) continue;
      if (saved.has(r.fingerprint)) continue;
      const checks = r.checks.filter(c => c.candidate?.url && Array.isArray(c.issues) &&
        ['confirmed', 'unverified', 'unavailable', 'access_limited'].includes(c.status) &&
        Number.isFinite(Date.parse(c.checkedAt)) && now - Date.parse(c.checkedAt) >= 0 && now - Date.parse(c.checkedAt) < 86400000);
      if (checks.length) saved.set(r.fingerprint, { checks, output: join(root, 'outputs', dir.name) });
    }
  }
  return saved;
}

export function baseDecision(result) {
  if (result.discovery.candidates.some(c => !result.checks.some(x => x.candidate.url === c.url)))
    return { code: 'pending', priority: 0, best: null, reason: 'Не все адреса проверены. Следующий запуск продолжит незавершённую проверку; оснований для предложения пока нет.' };
  if (!result.discovery.candidates.length) return { code: 'not_confirmed', priority: 0, best: null,
    reason: 'В сохранённых данных нет пригодного адреса самостоятельного сайта. Наличие сайта в Интернете и потребность в разработке не установлены.' };
  const decision = decide(result.discovery, result.checks);
  if (decision.priority && (!result.row.name || result.row.geoWarning || !availableContacts(result.row, result.checks).length)) {
    decision.priority = 0;
    decision.reason += ' В короткий список не включено: требуется уточнить название, географию или контакт.';
  }
  return decision;
}

export async function runSavedBase({ root, input, target = 20, refreshBase = false, signal, log = console.log,
  browserFactory = launchBrowser, auditorFactory = createAuditor, budgetMs = 600000, siteTimeoutMs = 45000, clock = Date.now } = {}) {
  const base = await loadSavedBase(root, input);
  const cache = join(root, '.cache'); await mkdir(cache, { recursive: true }); const release = await acquireLock(cache);
  let browser;
  try {
    const previous = refreshBase ? new Map() : await previousChecks(root, clock());
    const started = new Date(clock()).toISOString();
    const output = join(root, 'outputs', `base-audit-${started.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    const screenshots = join(output, 'screenshots'); await mkdir(screenshots, { recursive: true });
    await mkdir(join(output, 'evidence'), { recursive: true });
    const print = log;
    log = message => { print(message); appendFileSync(join(output, 'diagnostics.log'), `${new Date().toISOString()} ${message}\n`); };
    const report = { version: '0.2.4', mode: 'saved-base', startedAt: started, status: 'running', totalInput: base.rows.length,
      inputs: base.inputs, readRecords: base.readRecords, duplicates: base.duplicates, errors: [...base.warnings],
      sources: [{ city: 'Вся сохранённая база', status: 'not_requested', message: 'Только сохранённые данные. Overpass, Overture, Wikidata и AllThePlaces не запрашиваются.' }],
      scope: 'Saved website/email candidates only. No independent website discovery. No messages sent.', budgetMs, siteTimeoutMs };
    const results = base.rows.map((row, i) => ({ row, fingerprint: fingerprint(row), discovery: discover(row, unavailableSource),
      checks: [], checkedAt: '', evidenceFile: `evidence/org-${i + 1}.json` }));
    // Copy previous evidence into this report so its links remain portable. Reuse is explicit and at most 24h.
    for (const r of results) {
      const old = previous.get(r.fingerprint);
      if (old) for (const c of old.checks) {
        if (!r.discovery.candidates.some(x => x.url === c.candidate.url)) continue;
        const check = structuredClone(c); const copied = [];
        for (const name of check.screenshots || []) {
          if (!/^[a-zA-Z0-9_.-]+\.png$/.test(name)) continue;
          const dest = `${r.fingerprint.slice(0, 16)}-${name.replace(/^(?:[a-f0-9]{16}-)+/, '')}`;
          try { await writeFile(join(screenshots, dest), await readFile(join(old.output, 'screenshots', name))); copied.push(dest); }
          catch { /* A missing old screenshot is not a website defect. */ }
        }
        check.screenshots = copied; r.checks.push(check); r.reused = true;
      }
    }
    let shortlist = []; const evidenceSaved = new Map();
    const checkpoint = async () => {
      for (const r of results) {
        r.untestedCandidates = r.discovery.candidates.filter(c => !r.checks.some(x => x.candidate.url === c.url)).length;
        r.decision = baseDecision(r); r.contacts = availableContacts(r.row, r.checks); r.notes = resultNotes(r);
        if (r.checks.length) r.checkedAt = r.checks.at(-1).checkedAt;
        const serialized = JSON.stringify(r);
        if (evidenceSaved.get(r.evidenceFile) !== serialized) {
          await writeJson(join(output, r.evidenceFile), r); evidenceSaved.set(r.evidenceFile, serialized);
        }
      }
      shortlist = results.filter(r => r.decision.code === 'confirmed' && r.decision.priority > 0)
        .sort((a, b) => b.decision.priority - a.decision.priority).slice(0, target);
      report.pending = results.filter(r => r.decision.code === 'pending').length;
      report.checked = results.length - report.pending;
      report.confirmedSites = results.filter(r => r.decision.code === 'confirmed').length;
      report.withoutConfirmedSite = results.length - report.confirmedSites;
      report.withContacts = results.filter(r => r.contacts.length).length;
      report.withWebsiteCandidates = results.filter(r => r.discovery.candidates.length).length;
      report.websiteChecks = results.reduce((n, r) => n + r.checks.length, 0);
      report.shortlisted = shortlist.length;
      await writeJson(join(output, 'audit.json'), results); await writeJson(join(output, 'report.json'), report);
      for (const [file, rows] of [['audit.csv', results], ['shortlist.csv', shortlist],
        ['without-confirmed-site.csv', results.filter(r => r.decision.code !== 'confirmed')],
        ['pending.csv', results.filter(r => r.decision.code === 'pending')]]) await writeFile(join(output, file), auditCsv(rows), 'utf8');
      await writeFile(join(output, 'report.html'), htmlReport(report, results, shortlist), 'utf8');
    };
    log(`Версия 0.2.4: ${results.length} организаций, удалено повторов: ${base.duplicates}. Новый поиск и Overture отключены.`);
    await checkpoint();
    log(`Контакты: ${report.withContacts}; адреса сайтов для проверки: ${report.withWebsiteCandidates}. Отчёт уже сохранён: ${output}`);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), budgetMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let audit, stopped = false;
    try {
      for (const [i, r] of results.entries()) {
        for (const candidate of r.discovery.candidates) {
          if (combined.aborted || stopped) break;
          if (r.checks.some(c => c.candidate.url === candidate.url)) continue;
          if (!browser) {
            try { browser = await browserFactory(); audit = auditorFactory({ browser }); }
            catch { report.errors.push('Браузер не запущен. Контакты сохранены; сайты оставлены для проверки. Выполните npm.cmd run setup:audit.'); stopped = true; break; }
          }
          log(`[${i + 1}/${results.length}] ${r.row.name || '(без названия)'}: ${candidate.url}, до ${siteTimeoutMs / 1000} с.`);
          const check = await audit(r.row, candidate, { outputDir: screenshots, slug: `org-${i + 1}-site-${r.checks.length + 1}`,
            signal: combined, timeoutMs: siteTimeoutMs });
          // Cancellation/global budget leaves this URL pending, rather than caching a false failure for 24h.
          if (combined.aborted) break;
          check.checkedAt ||= new Date(clock()).toISOString(); r.checks.push(check);
          await checkpoint(); log(`  ${STATUS[r.decision.code]}`);
        }
        if (combined.aborted || stopped) break;
      }
    } finally { clearTimeout(timer); }
    report.status = signal?.aborted ? 'interrupted' : 'complete';
    await checkpoint();
    if (report.status !== 'interrupted' && (report.pending || report.errors.length || results.some(r => r.checks.some(c => ['unavailable', 'access_limited'].includes(c.status))))) report.status = 'partial';
    report.finishedAt = new Date(clock()).toISOString();
    await checkpoint();
    log(`Готово: ${report.checked}/${results.length}; подтверждённых сайтов: ${report.confirmedSites}; короткий список: ${shortlist.length}; ожидают проверки: ${report.pending}. Статус: ${report.status}.`);
    log(`Откройте ${join(output, 'report.html')}. Повторный запуск продолжит оставшиеся адреса, используя проверки за последние 24 часа.`);
    return { output, report, results, shortlist, exitCode: report.status === 'complete' ? 0 : 2 };
  } finally { try { await browser?.close(); } finally { await release(); } }
}
