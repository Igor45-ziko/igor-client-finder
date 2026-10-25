import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CITIES } from '../src/config.mjs';
import { normalizeElement } from '../src/model.mjs';
import { discover, matchOverture, siteEvidence, isDirectory } from '../src/audit/matching.mjs';
import { bboxFor, loadOverture, validatePlaces } from '../src/audit/overture.mjs';
import { decide, runAudit, findInput, auditQueue, htmlReport } from '../src/audit/run.mjs';
import { auditArgs } from '../src/audit/cli.mjs';
import { publicUrl, publicIp } from '../src/audit/browser.mjs';
import { temporary, element, timestamp, response } from './helpers.mjs';

const row = () => normalizeElement(element(1, { name: 'Сигма Мотор ТЕСТ', 'addr:street': 'Тестовая', 'addr:housenumber': '17', 'addr:city': 'Тверь' }), CITIES[0], timestamp);
function feature(overrides = {}) {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [CITIES[0].lon, CITIES[0].lat] },
    properties: { id: 'synthetic-fixture-only', names: { primary: 'Сигма Мотор ТЕСТ' }, phones: ['+7 000 000-00-01'], websites: ['https://sigma.example.org'],
      addresses: [{ freeform: 'Тестовая 17', locality: 'Тверь' }], sources: [{ dataset: 'SYNTHETIC TEST DATA' }], ...overrides } };
}
const providerData = features => ({ status: 'ok', data: { type: 'FeatureCollection', features }, fetchedAt: timestamp,
  release: '2026-10-15.0', sourceUrl: 'https://stac.overturemaps.org/2026-10-15.0/catalog.json' });

test('independent Overture supplies a website that is absent in OSM and records evidence', () => {
  const r = row(); assert.equal(r.rawWebsites.length, 0);
  const found = discover(r, providerData([feature()]));
  assert.equal(found.candidates.length, 1); assert.equal(found.candidates[0].url, 'https://sigma.example.org/');
  assert.equal(found.candidates[0].sources[0].type, 'overture');
  assert.equal(found.candidates[0].sources[0].recordId, 'synthetic-fixture-only');
  assert.equal(found.matches[0].phone, true);
});
test('same name at distant coordinates or a conflicting nearby company is not enough', () => {
  const far = feature(); far.geometry.coordinates[1] += 1;
  assert.equal(matchOverture(row(), far), null);
  const wrong = feature({ names: { primary: 'Другая компания' }, phones: ['+7 000 000-00-99'], addresses: [] });
  assert.equal(matchOverture(row(), wrong), null);
});
test('corporate email domain is only a candidate, public mailboxes are excluded', () => {
  const r = row(); r.emails = [{ raw: 'info@service.example.org', key: 'info@service.example.org' }, { raw: 'a@mail.ru', key: 'a@mail.ru' }];
  const found = discover(r, { status: 'unavailable' });
  assert.equal(found.candidates.length, 1); assert.equal(found.candidates[0].sources[0].type, 'email-domain');
  assert.equal(decide(found, []).code, 'unavailable');
});
test('social networks and directory links are not official website confirmations', () => {
  assert.equal(isDirectory('https://www.yandex.ru/maps'), true);
  const r = row(); r.rawWebsites = ['https://vk.com/test'];
  const found = discover(r, providerData([]));
  assert.equal(found.candidates.length, 0); assert.equal(found.directoryLinks.length, 1);
});
test('a matching name alone cannot confirm a website', () => {
  assert.equal(siteEvidence(row(), 'Сигма Мотор ТЕСТ — ремонт машин').confirmed, false);
  assert.equal(siteEvidence(row(), 'Сигма Мотор ТЕСТ Телефон +7 000 000-00-01').confirmed, true);
  assert.equal(siteEvidence(row(), 'Сигма Мотор ТЕСТ Тверь Тестовая 17').confirmed, true);
  assert.equal(siteEvidence(row(), 'Сигма Мотор ТЕСТ Тверь Другой адрес 55 +7 000 000-00-99').confirmed, false);
});
test('generic name and a central phone require additional identity evidence', () => {
  const r = row(); r.name = 'Автосервис';
  assert.equal(siteEvidence(r, 'Автосервис +7 000 000-00-01').confirmed, false);
  assert.equal(siteEvidence(r, 'Автосервис Тестовая 17 +7 000 000-00-01').confirmed, true);
});
test('email substring and an unrelated house number cannot confirm a lookalike site', () => {
  const r = row(); r.emails = [{ raw: 'office@example.org', key: 'office@example.org' }]; r.phones = [];
  assert.equal(siteEvidence(r, 'Сигма Мотор ТЕСТ other-office@example.org').confirmed, false);
  assert.equal(siteEvidence(r, 'Сигма Мотор ТЕСТ office@example.org.evil.com').confirmed, false);
  assert.equal(siteEvidence(r, 'Сигма Мотор ТЕСТ office@example.org').confirmed, true);
  const unrelated = 'Сигма Мотор ТЕСТ Тверь Тестовая ' + 'посторонний текст '.repeat(20) + '17';
  assert.equal(siteEvidence(r, unrelated).confirmed, false);
});
test('blocked independent search never becomes a successful not-found result', () => {
  const found = discover(row(), { status: 'unavailable' });
  assert.equal(decide(found, []).code, 'incomplete'); assert.equal(decide(found, []).priority, 0);
  const searched = discover(row(), providerData([]));
  assert.equal(decide(searched, []).code, 'not_found');
});
test('only confirmed sites with concrete issues get high priority; ambiguity is not auto-resolved', () => {
  const c = url => ({ status: 'confirmed', finalUrl: url, candidate: { url }, issues: [] });
  assert.equal(decide({ candidates: [], independentStatus: 'ok' }, [c('https://a.example.org')]).priority, 0);
  const faulty = c('https://a.example.org'); faulty.issues = [{ label: 'HTTP 404', weight: 4 }];
  assert.ok(decide({}, [faulty]).priority > 70);
  assert.equal(decide({}, [faulty, c('https://b.example.org')]).code, 'ambiguous');
});
test('public address guard rejects local, credentialed and non-web URLs, including DNS answers', async () => {
  for (const ip of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '169.254.169.254', '192.168.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(publicIp(ip), false);
  assert.equal(publicIp('8.8.8.8'), true);
  for (const url of ['file:///etc/passwd', 'http://localhost', 'http://127.0.0.1', 'http://user:pw@example.org', 'https://example.org:1234'])
    await assert.rejects(publicUrl(url));
  await assert.rejects(publicUrl('https://example.org', async () => [{ address: '127.0.0.1' }]));
  assert.equal((await publicUrl('https://example.org', async () => [{ address: '8.8.8.8' }])).hostname, 'example.org');
});
test('Overture download always has a bounded bbox, explicit type, timeout and STAC', async t => {
  const root = await temporary(t); let called;
  const result = await loadOverture(CITIES[0], { root, env: {}, clock: () => timestamp, log: () => {},
    fetchImpl: async () => response({ latest: '2026-10-15.0' }), installer: async () => 'synthetic-downloader',
    download: async (exe, args, { output }) => { called = args; await writeFile(output, JSON.stringify(providerData([feature()]).data)); } });
  assert.equal(result.status, 'ok'); assert.equal(result.data.features.length, 1);
  assert.ok(called.includes('--type=place')); assert.ok(called.includes('--stac'));
  assert.ok(called.find(x => x.startsWith('--bbox='))); assert.ok(called.includes('--request_timeout'));
  const bounds = bboxFor(CITIES[0]); assert.ok(bounds[2] - bounds[0] < 1); assert.ok(bounds[3] - bounds[1] < 1);
  const cached = await loadOverture(CITIES[0], { root, clock: () => timestamp, env: { HTTPS_PROXY: 'configured' } });
  assert.equal(cached.fromCache, true);
});
test('proxy environment does not launch a direct native S3 connection', async t => {
  const root = await temporary(t); let called = false;
  const result = await loadOverture(CITIES[0], { root, env: { HTTPS_PROXY: 'configured' }, fetchImpl: async () => { called = true; } });
  assert.equal(result.status, 'unavailable'); assert.equal(called, false);
});
test('a failed or missing download output cannot become empty successful discovery', async t => {
  const root = await temporary(t);
  const result = await loadOverture(CITIES[0], { root, env: {}, log: () => {}, fetchImpl: async () => response({ latest: '2026-10-15.0' }),
    installer: async () => 'synthetic', download: async () => {} });
  assert.equal(result.status, 'unavailable');
  assert.throws(() => validatePlaces({ features: [] }));
});
test('audit picks a previous nonempty run and leaves failed/empty search outputs untouched', async t => {
  const root = await temporary(t);
  for (const [dir, data] of [['2026-10-24', [row()]], ['2026-10-25', []]]) {
    await mkdir(join(root, 'outputs', dir), { recursive: true }); await writeFile(join(root, 'outputs', dir, 'organizations.json'), JSON.stringify(data));
  }
  assert.equal(await findInput(root), join(root, 'outputs', '2026-10-24', 'organizations.json'));
});
test('queue includes both missing-site and existing-site organizations within its limit', () => {
  const a = row(), b = row(); b.rawWebsites = ['https://example.org']; b.name = 'Вторая организация';
  assert.deepEqual(auditQueue([a, a, a, b], 2).map(x => x.name), [a.name, b.name]);
  assert.throws(() => auditArgs(['--limit', '999']));
});
test('end-to-end audit discovers a new site, exports reasons and screenshots links', async t => {
  const root = await temporary(t); await mkdir(join(root, 'outputs', 'source'), { recursive: true });
  await writeFile(join(root, 'outputs', 'source', 'organizations.json'), JSON.stringify([row()]));
  const result = await runAudit({ root, log: () => {}, provider: async () => providerData([feature()]),
    browserFactory: async () => ({ close: async () => {} }), auditorFactory: () => async (r, candidate) => ({ candidate, finalUrl: candidate.url,
      status: 'confirmed', matched: ['название', 'телефон'], issues: [{ label: 'Тестовое переполнение', weight: 3 }], screenshots: [] }) });
  assert.equal(result.report.confirmedSites, 1); assert.equal(result.shortlist.length, 1);
  const csv = await readFile(join(result.output, 'shortlist.csv'), 'utf8');
  assert.match(csv, /sigma\.example\.org/); assert.match(csv, /Overture synthetic-fixture-only/);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const evidence = JSON.parse(await readFile(join(result.output, 'evidence', 'org-1.json'), 'utf8'));
  assert.equal(evidence.discovery.candidates[0].sources[0].type, 'overture');
});
test('unavailable source yields partial audit and an empty shortlist, never false no-site leads', async t => {
  const root = await temporary(t); await mkdir(join(root, 'outputs', 'source'), { recursive: true });
  await writeFile(join(root, 'outputs', 'source', 'organizations.json'), JSON.stringify([row()]));
  const result = await runAudit({ root, log: () => {}, provider: async () => ({ status: 'unavailable', message: 'TEST BLOCK' }) });
  assert.equal(result.report.status, 'partial'); assert.equal(result.exitCode, 2); assert.equal(result.shortlist.length, 0);
  assert.equal(result.results[0].decision.code, 'incomplete');
});
test('HTML report escapes untrusted names and never interprets external instructions', () => {
  const r = { row: { ...row(), name: '<script>alert(1)</script>' }, decision: { code: 'not_found', reason: '<img src=x>', priority: 30 },
    discovery: { candidates: [] }, evidenceFile: 'evidence/org-1.json' };
  const html = htmlReport({ checked: 1, totalInput: 1, status: 'complete', sources: [] }, [r], [r]);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
});
