import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CITIES } from '../src/config.mjs';
import { normalizeElement } from '../src/model.mjs';
import { loadSavedBase, runSavedBase } from '../src/audit/saved-base.mjs';
import { auditArgs } from '../src/audit/cli.mjs';
import { createAuditor } from '../src/audit/browser.mjs';
import { availableContacts } from '../src/audit/contacts.mjs';
import { temporary, element, timestamp } from './helpers.mjs';

// All companies in this file are synthetic. No external services are queried.
const row = (id, tags = {}, when = timestamp) => normalizeElement(element(id,
  { name: `Вымышленная мастерская ${id}`, phone: `+7 000 000 ${String(id).padStart(4, '0')}`, ...tags }), CITIES[0], when);
async function save(root, name, rows) {
  const path = join(root, 'outputs', name); await mkdir(path, { recursive: true });
  await writeFile(join(path, 'organizations.json'), JSON.stringify(rows)); return join(path, 'organizations.json');
}
const browserFactory = async () => ({ close: async () => {} });
const checked = (candidate, status = 'confirmed', issues = [{ code: 'viewport', weight: 2, label: 'Синтетическая проблема viewport' }]) =>
  ({ candidate, status, issues, finalUrl: candidate.url, pages: [], matched: ['название', 'телефон'], screenshots: [] });
const opts = { log: () => {}, browserFactory, clock: () => timestamp + 1000 };

test('saved base merges every snapshot, prefers latest object, preserves inputs and ignores empty search', async t => {
  const root = await temporary(t);
  const path = await save(root, 'old', [row(1, { website: 'https://old.example.org' }), row(2)]);
  const original = await readFile(path, 'utf8');
  await save(root, 'new', [row(1, { phone: '' }, timestamp + 10), row(3)]);
  await save(root, 'empty', []);
  const result = await loadSavedBase(root);
  assert.equal(result.rows.length, 3); assert.equal(result.duplicates, 1);
  assert.equal(result.rows.find(r => r.sourceIds[0] === 'node/1').rawWebsites.length, 0);
  assert.equal(result.rows.find(r => r.sourceIds[0] === 'node/1').phones.length, 0);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('empty saved database is an error and never starts a new search', async t => {
  const root = await temporary(t); await save(root, 'empty', []);
  await assert.rejects(() => runSavedBase({ root, ...opts }), /Новый поиск автоматически не запускается/);
});

test('malformed snapshot is reported, valid saved data remains usable', async t => {
  const root = await temporary(t); await save(root, 'good', [row(1)]); await save(root, 'bad', { unexpected: true });
  const result = await runSavedBase({ root, ...opts });
  assert.equal(result.report.status, 'partial'); assert.equal(result.report.totalInput, 1);
  assert.match(result.report.errors[0], /bad/);
});

test('all 269 synthetic records survive, including unnamed, contactless and other-city records; no browser or source call', async t => {
  const root = await temporary(t);
  const rows = Array.from({ length: 269 }, (_, i) => row(i + 1));
  rows[0].name = ''; rows[1].phones = []; rows[2].geoWarning = 'Другой город';
  await save(root, 'original', rows);
  for (const folder of ['.cache', '.tools']) { await mkdir(join(root, folder)); await writeFile(join(root, folder, 'keep'), 'preserve'); }
  const result = await runSavedBase({ root, ...opts, browserFactory: () => assert.fail('No website to visit') });
  assert.equal(result.results.length, 269); assert.equal(result.report.checked, 269); assert.equal(result.report.status, 'complete');
  assert.equal(result.shortlist.length, 0); assert.equal(result.report.withoutConfirmedSite, 269);
  assert.ok(result.results.every(r => r.decision.code === 'not_confirmed'));
  const csv = await readFile(join(result.output, 'without-confirmed-site.csv'), 'utf8');
  assert.equal(csv.split('\r\n').length, 271);
  for (const folder of ['.cache', '.tools']) assert.equal(await readFile(join(root, folder, 'keep'), 'utf8'), 'preserve');
  assert.equal(JSON.parse(await readFile(join(root, 'outputs/original/organizations.json'), 'utf8')).length, 269);
});

test('shortlist contains only confirmed problems with contacts; errors and lookalikes are separate', async t => {
  const root = await temporary(t);
  const rows = Array.from({ length: 5 }, (_, i) => row(i + 1, { website: `https://site-${i + 1}.example.org` }));
  rows[3].phones = []; rows[4].geoWarning = 'География не подтверждена';
  await save(root, 'original', rows);
  const result = await runSavedBase({ root, ...opts, auditorFactory: () => async (r, c) => checked(c,
    r.sourceIds[0] === 'node/2' ? 'unavailable' : r.sourceIds[0] === 'node/3' ? 'unverified' : 'confirmed') });
  assert.equal(result.results.length, 5); assert.equal(result.shortlist.length, 1);
  assert.equal(result.shortlist[0].row.sourceIds[0], 'node/1');
  assert.equal(result.report.status, 'partial'); assert.equal(result.report.withoutConfirmedSite, 2);
  const html = await readFile(join(result.output, 'report.html'), 'utf8');
  assert.match(html, /Организация → источник → результат/); assert.match(html, /details.html/);
  const details = await readFile(join(result.output, 'details.html'), 'utf8');
  assert.match(details, /without-confirmed-site.csv/); assert.match(details, /актуальность и согласие/);
});

test('email domains and social-only websites remain distinct and keep available contacts', async t => {
  const root = await temporary(t);
  await save(root, 'original', [row(1, { email: 'info@synthetic.example.org' }), row(2, { phone: '', website: 'https://vk.com/synthetic_only' })]);
  const called = [];
  const result = await runSavedBase({ root, ...opts, auditorFactory: () => async (r, c) => { called.push(c); return checked(c, 'unverified'); } });
  assert.equal(called.length, 1); assert.equal(called[0].sources[0].type, 'email-domain');
  const social = result.results.find(r => r.row.sourceIds[0] === 'node/2');
  assert.equal(social.decision.code, 'not_confirmed'); assert.equal(social.contacts[0].channel, 'vk');
  assert.equal(result.shortlist.length, 0);
});

test('same-day checks reused with explicit dates; refresh and changed input force fresh audit', async t => {
  const root = await temporary(t); const rows = [row(1, { website: 'https://synthetic.example.org' })];
  const path = await save(root, 'original', rows); let calls = 0;
  const options = { root, ...opts, auditorFactory: () => async (r, c) => { calls++; return checked(c); } };
  await runSavedBase(options); assert.equal(calls, 1);
  const next = await runSavedBase({ ...options, clock: () => timestamp + 2000 });
  assert.equal(calls, 1); assert.equal(next.results[0].reused, true);
  assert.equal(next.results[0].checkedAt, new Date(timestamp + 1000).toISOString());
  await runSavedBase({ ...options, refreshBase: true }); assert.equal(calls, 2);
  rows[0].address = 'Новый адрес'; await writeFile(path, JSON.stringify(rows));
  await runSavedBase(options); assert.equal(calls, 3);
  await runSavedBase({ ...options, clock: () => timestamp + 86400001 }); assert.equal(calls, 3);
  await runSavedBase({ ...options, clock: () => timestamp + 86402000 }); assert.equal(calls, 4);
});

test('global budget keeps the full inventory and pending URLs; next run resumes completed checks', async t => {
  const root = await temporary(t); await save(root, 'original', [row(1, { website: 'https://one.example.org' }), row(2, { website: 'https://two.example.org' }), row(3)]);
  const result = await runSavedBase({ root, ...opts, budgetMs: 30, auditorFactory: () => async (r, c, { signal }) => {
    if (r.sourceIds[0] === 'node/2') await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
    return checked(c);
  } });
  assert.equal(result.results.length, 3); assert.equal(result.report.status, 'partial'); assert.equal(result.report.pending, 1);
  assert.equal(result.results[1].checks.length, 0);
  const calls = [];
  const next = await runSavedBase({ root, ...opts, clock: () => timestamp + 2000,
    auditorFactory: () => async (r, c) => { calls.push(r.sourceIds[0]); return checked(c); } });
  assert.deepEqual(calls, ['node/2']); assert.equal(next.report.pending, 0);
});

test('browser startup failure still exports every contact and leaves sites pending', async t => {
  const root = await temporary(t); await save(root, 'original', [row(1, { website: 'https://synthetic.example.org' }), row(2)]);
  const result = await runSavedBase({ root, ...opts, browserFactory: async () => { throw new Error('missing browser'); } });
  assert.equal(result.report.status, 'partial'); assert.equal(result.report.pending, 1);
  assert.equal(result.report.withContacts, 2); assert.match(await readFile(join(result.output, 'audit.csv'), 'utf8'), /Вымышленная мастерская 2/);
});

test('cancellation retains all rows and creates an interrupted report', async t => {
  const root = await temporary(t); await save(root, 'original', [row(1, { website: 'https://synthetic.example.org' }), row(2)]);
  const controller = new AbortController(); controller.abort();
  const result = await runSavedBase({ root, ...opts, signal: controller.signal });
  assert.equal(result.report.status, 'interrupted'); assert.equal(result.results.length, 2); assert.equal(result.report.pending, 1);
});

test('website deadline interrupts a stuck DNS guard; no fetch is started even if DNS resolves later', async () => {
  let finish; let fetched = 0;
  const audit = createAuditor({ browser: {}, guard: () => new Promise(resolve => { finish = resolve; }), fetchImpl: () => { fetched++; assert.fail('late request'); } });
  const start = Date.now();
  const result = await audit(row(1), { url: 'https://synthetic.example.org', sources: [] }, { timeoutMs: 25 });
  assert.equal(result.errorCode, 'SITE_TIMEOUT'); assert.equal(result.failureStage, 'address');
  assert.ok(Date.now() - start < 2000);
  finish(new URL('https://synthetic.example.org')); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fetched, 0);
});

test('saved-base arguments prohibit accidental Overture or partial row selection', () => {
  assert.equal(auditArgs(['--saved-base']).savedBase, true);
  assert.equal(auditArgs(['--saved-base', '--refresh-base']).refreshBase, true);
  assert.throws(() => auditArgs(['--saved-base', '--overture', 'online']));
  assert.throws(() => auditArgs(['--saved-base', '--limit', '5']));
  assert.throws(() => auditArgs(['--refresh-base']));
});
