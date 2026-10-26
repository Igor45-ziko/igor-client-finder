import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeElement } from '../src/model.mjs';
import { CITIES } from '../src/config.mjs';
import { loadOverture } from '../src/audit/overture.mjs';
import { runAudit } from '../src/audit/run.mjs';
import { auditArgs } from '../src/audit/cli.mjs';
import { probe, diagnoseSources, WIKIDATA_RECORD, ATP_MANIFEST, validateAtpManifest } from '../src/audit/diagnostics.mjs';
import { temporary, element, timestamp, response } from './helpers.mjs';

// Structure follows upstream ci/run_all_spiders.sh and the user's real field list.
// Values/URLs are synthetic; this is NOT a captured live response or business data.
const flatManifest = JSON.parse(await readFile(new URL('./fixtures/alltheplaces-flat.json', import.meta.url), 'utf8'));

const makeRow = (id = 1, city = CITIES[0], site = true) => normalizeElement(element(id,
  { name: 'Синтетический автосервис для теста', ...(site ? { website: `https://synthetic-${id}.example.org/` } : {}) }, { lat: city.lat, lon: city.lon }), city, timestamp);
async function input(t, rows) {
  const root = await temporary(t); await mkdir(join(root, 'outputs', 'old'), { recursive: true });
  await mkdir(join(root, '.cache'), { recursive: true }); await writeFile(join(root, '.cache', 'keep.txt'), 'preserve-cache');
  await writeFile(join(root, 'outputs', 'old', 'organizations.json'), JSON.stringify(rows)); return root;
}
const browserFactory = async () => ({ close: async () => {} });
const confirmed = candidate => ({ candidate, status: 'confirmed', finalUrl: candidate.url, matched: ['название', 'телефон'],
  issues: [{ label: 'Синтетическая проблема viewport', weight: 2 }], pages: [] });

test('default launch never requests a fresh Overture download', async t => {
  assert.equal(auditArgs([]).overtureMode, 'cache');
  assert.equal(auditArgs(['--overture', 'online']).overtureMode, 'online');
  assert.throws(() => auditArgs(['--overture', 'anything']));
  const root = await input(t, [makeRow(1, CITIES[0], false)]);
  const result = await loadOverture(CITIES[0], { root, mode: 'cache', env: {}, fetchImpl: () => assert.fail('network request') });
  assert.equal(result.status, 'skipped');
  const report = await runAudit({ root, log: () => {} });
  assert.equal(report.report.status, 'partial'); assert.equal(report.shortlist.length, 0);
  assert.equal(report.results[0].decision.code, 'incomplete');
  assert.equal(await readFile(join(root, '.cache', 'keep.txt'), 'utf8'), 'preserve-cache');
});
test('known official site completes without calling an independent provider', async t => {
  const root = await input(t, [makeRow()]);
  const result = await runAudit({ root, log: () => {}, overtureMode: 'online', provider: () => assert.fail('source delays known site'),
    browserFactory, auditorFactory: () => async (row, candidate) => confirmed(candidate) });
  assert.equal(result.report.status, 'complete'); assert.equal(result.shortlist.length, 1);
  assert.equal(result.results[0].notes.errors, '');
  assert.equal(result.report.sources[0].status, 'not_needed');
});
test('known-site evidence and HTML exist BEFORE optional lookup; source failure cannot erase them', async t => {
  const root = await input(t, [makeRow(), makeRow(2, CITIES[0], false)]); let audited = false;
  const result = await runAudit({ root, log: () => {}, overtureMode: 'online', browserFactory,
    auditorFactory: () => async (row, candidate) => { audited = true; return confirmed(candidate); },
    provider: async () => {
      assert.equal(audited, true);
      const output = (await readdir(join(root, 'outputs'))).find(d => d.startsWith('audit-'));
      assert.match(await readFile(join(root, 'outputs', output, 'report.html'), 'utf8'), /Синтетическая проблема viewport/);
      throw new Error('synthetic source outage');
    } });
  assert.equal(result.report.status, 'partial'); assert.equal(result.shortlist.length, 1);
  assert.match(result.report.sources[0].message, /synthetic source outage/);
  assert.equal(JSON.parse(await readFile(join(root, 'outputs', 'old', 'organizations.json'))).length, 2);
});
test('additional source budget is shared across cities, not restarted for every city', async t => {
  const root = await input(t, [makeRow(1, CITIES[0], false), makeRow(2, CITIES[1], false)]); let calls = 0;
  const result = await runAudit({ root, log: () => {}, overtureMode: 'online', sourceBudgetMs: 20,
    provider: async (city, { signal }) => {
      calls++;
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { status: 'unavailable', message: 'synthetic total timeout' };
    } });
  assert.equal(calls, 1); assert.equal(result.report.status, 'partial'); assert.equal(result.report.sources.length, 2);
});
test('cached Overture remains useful without network, and old cache content is unchanged', async t => {
  const root = await input(t, [makeRow(1, CITIES[0], false)]);
  const fakeData = { type: 'FeatureCollection', features: [] };
  await loadOverture(CITIES[0], { root, env: {}, log: () => {}, clock: () => timestamp, fetchImpl: async () => response({ latest: '2026-10-15.0' }),
    installer: async () => 'synthetic', download: async (exe, args, { output, timeoutMs }) => {
      assert.equal(timeoutMs, 60000); await writeFile(output, JSON.stringify(fakeData));
    } });
  const dir = join(root, '.cache', 'overture'), name = (await readdir(dir))[0], before = await readFile(join(dir, name));
  const result = await loadOverture(CITIES[0], { root, mode: 'cache', clock: () => timestamp + 1, fetchImpl: () => assert.fail('network') });
  assert.equal(result.status, 'ok'); assert.equal(result.fromCache, true);
  assert.deepEqual(await readFile(join(dir, name)), before);
});
test('supplementary match to an already checked candidate does not repeat browser work', async t => {
  const row = makeRow(); const root = await input(t, [row]); let calls = 0;
  const result = await runAudit({ root, log: () => {}, browserFactory,
    auditorFactory: () => async (row, candidate) => { calls++; return { candidate, status: 'unverified', issues: [], matched: [] }; },
    provider: async () => ({ status: 'ok', fetchedAt: timestamp, data: { features: [{ type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.lon, row.lat] }, properties: { id: 'synthetic-only', names: { primary: row.name },
        phones: row.phones.map(p => p.raw), websites: row.rawWebsites } }] } }) });
  assert.equal(calls, 1); assert.equal(result.results[0].decision.code, 'unverified');
});
test('off mode never calls the source and never claims a successful no-site finding', async t => {
  const root = await input(t, [makeRow(1, CITIES[0], false)]);
  const result = await runAudit({ root, log: () => {}, overtureMode: 'off', provider: () => assert.fail('provider called') });
  assert.equal(result.results[0].decision.code, 'incomplete'); assert.equal(result.shortlist.length, 0);
});
test('diagnostic HTTP denial records Retry-After and never follows redirects', async () => {
  let calls = 0;
  const result = await probe('https://synthetic.example.org', { fetchImpl: async (url, opts) => {
    calls++; assert.equal(opts.redirect, 'manual'); return new Response('', { status: 429, headers: { 'retry-after': '600' } });
  } });
  assert.equal(calls, 1); assert.equal(result.http, 429); assert.equal(result.retryAfter, '600'); assert.equal(result.status, 'unavailable');
});
test('diagnostic only reads a small prefix even when Range is ignored', async () => {
  let cancelled = false;
  const result = await probe('https://synthetic.example.org', { prefixOnly: true, limit: 4, fetchImpl: async (url, opts) => {
    assert.equal(opts.headers.Range, 'bytes=0-3');
    return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from('PAR1some more data')); }, cancel() { cancelled = true; } }));
  } });
  assert.equal(result.body, 'PAR1'); assert.equal(result.bytes, 4); assert.equal(cancelled, true);
});
test('short probes enforce timeouts and total cancellation without starting later probes', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await probe('https://synthetic.example.org', { timeoutMs: 10,
      fetchImpl: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
    assert.equal(result.code, 'TIMEOUT');
    let calls = 0;
    const report = await diagnoseSources({ log: () => {}, totalMs: 10, fetchImpl: (url, { signal }) => {
      calls++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    assert.equal(calls, 1); assert.equal(report.status, 'interrupted');
  } finally { clearTimeout(keepAlive); }
});
test('diagnostic success requires valid content, never HTML login pages or malformed JSON', async () => {
  const report = await diagnoseSources({ log: () => {}, fetchImpl: async () => new Response('<html>Sign in</html>') });
  assert.equal(report.status, 'partial'); assert.ok(report.checks.some(x => x.parseError));
});
test('diagnostics preserve public evidence but do not save a raw response or invent source results', async () => {
  const report = await diagnoseSources({ log: () => {}, fetchImpl: async url => {
    if (url.endsWith('/catalog.json')) return response({ latest: '2026-10-15.0' });
    if (url.endsWith('/collections.parquet')) return new Response('PAR1synthetic');
    if (url.includes('s3.us-west-2')) return new Response('<ListBucketResult><Key>synthetic.parquet</Key></ListBucketResult>');
    if (url === WIKIDATA_RECORD) return response({ entities: { Q129632037: { id: 'Q129632037', claims: { P856: [{ mainsnak: { datavalue: { value: 'https://synthetic.example.org' } } }] } } } });
    if (url === ATP_MANIFEST) return response(flatManifest);
    assert.fail(url);
  } });
  assert.equal(report.status, 'complete'); assert.equal(report.checks.length, 5);
  const manifestCheck = report.checks.find(x => x.url === ATP_MANIFEST);
  assert.equal(manifestCheck.manifestValid, true); assert.equal(manifestCheck.manifestFormat, 'flat');
  assert.deepEqual(manifestCheck.manifestErrors, []);
  assert.ok(report.checks.every(x => !('body' in x)));
  assert.deepEqual(report.checks.find(x => x.url === WIKIDATA_RECORD).publishedWebsites, ['https://synthetic.example.org']);
});
test('source budget cancellation is not mislabeled as user Ctrl+C', async () => {
  const { runDownload } = await import('../src/audit/overture.mjs');
  const { EventEmitter } = await import('node:events'); const { PassThrough } = await import('node:stream');
  const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
  const controller = new AbortController(); const logs = [];
  const result = runDownload('synthetic', [], { signal: controller.signal, spawnImpl: () => child, killTree: async () => {}, log: x => logs.push(x) });
  controller.abort(new Error('source budget'));
  await assert.rejects(result, /общему ограничению времени/);
  assert.equal(logs.some(x => x.includes('остановлена пользователем')), false);
});
test('unconfirmed candidate with disabled source remains partial, not fully verified', async t => {
  const root = await input(t, [makeRow()]);
  const result = await runAudit({ root, log: () => {}, overtureMode: 'off', browserFactory,
    auditorFactory: () => async (row, candidate) => ({ candidate, status: 'unverified', matched: [], issues: [] }) });
  assert.equal(result.report.status, 'partial'); assert.equal(result.shortlist.length, 0);
  assert.equal(result.results[0].decision.code, 'unverified');
});

test('AllThePlaces real flat field structure is valid without groups; extra fields are allowed', () => {
  assert.equal('groups' in flatManifest, false);
  assert.deepEqual(validateAtpManifest({ ...flatManifest, future_field: { arbitrary: true } }), { valid: true, format: 'flat', errors: [] });
});
test('AllThePlaces grouped producer remains supported with counters and real artifact fields', () => {
  const manifest = { spiders: 2, total_lines: 10, stats_url: 'https://data.example.org/stats.json', groups: [
    { name: 'brands', spider_count: 2, feature_count: 10, zip_url: 'https://data.example.org/brands.zip', parquet_url: 'https://data.example.org/brands.parquet' },
  ] };
  assert.deepEqual(validateAtpManifest(manifest), { valid: true, format: 'grouped', errors: [] });
  assert.equal(validateAtpManifest({ spiders: 0, total_lines: 0, groups: [] }).valid, true);
  assert.equal(validateAtpManifest({ ...manifest, groups: [] }).valid, false);
});
test('AllThePlaces rejects invalid structures, counters and unsafe artifact URLs with specific reasons', () => {
  for (const value of [null, [], 'text', {}, { spiders: 2, total_lines: 10 },
    { ...flatManifest, spiders: -1 }, { ...flatManifest, total_lines: '10' }, { ...flatManifest, total_lines: 1.5 },
    { ...flatManifest, spiders: Number.MAX_SAFE_INTEGER + 1 }, { ...flatManifest, output_url: '' },
    { ...flatManifest, parquet_url: 'javascript:alert(1)' }, { ...flatManifest, stats_url: '/relative.json' },
    { ...flatManifest, output_url: 'https://user:password@example.org/file.zip' },
    { spiders: 1, total_lines: 1, groups: [null] }, { spiders: 1, total_lines: 1, groups: [{ name: 'brands' }] },
    { spiders: 1, total_lines: 1, groups: [{ name: 'brands', zip_url: 'invalid' }] }]) {
    const result = validateAtpManifest(value); assert.equal(result.valid, false, JSON.stringify(value)); assert.ok(result.errors.length);
  }
});
test('flat AllThePlaces format failure is reported as schema failure rather than network or JSON failure', async () => {
  const report = await diagnoseSources({ log: () => {}, fetchImpl: async url => {
    if (url === ATP_MANIFEST) return response({ ...flatManifest, total_lines: -1 });
    return new Response('', { status: 403 });
  } });
  const item = report.checks.find(x => x.url === ATP_MANIFEST);
  assert.equal(item.status, 'reachable'); assert.equal(item.http, 200); assert.equal(item.manifestValid, false);
  assert.match(item.manifestErrors.join(' '), /total_lines/); assert.equal(item.parseError, undefined);
  assert.equal(report.status, 'partial');
});
