import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { directoryReference, sourceReferences, compactReport, prospect, internalTargets } from '../src/audit/prospects.mjs';
import { reformatSavedReport } from '../src/audit/report-only.mjs';
import { CITIES, MOSCOW_AREAS, parseArgs, queryFor } from '../src/config.mjs';
import { normalizeElement } from '../src/model.mjs';
import { run } from '../src/run.mjs';
import { temporary, element, timestamp, payload, response } from './helpers.mjs';

// Invented IDs/companies are test data, never packaged or used as a discovery fallback.
const fixture = () => ({ row: normalizeElement(element(1, { name: 'Synthetic only', phone: '+7 000 000-00-01' }), CITIES[0], timestamp),
  checks: [], discovery: { candidates: [] }, decision: { code: 'not_confirmed' } });
test('directory recognition accepts explicit company paths only, no searches, pins, short URLs or lookalike hosts', () => {
  for (const url of ['https://yandex.ru/maps/org/synthetic/123456/', 'https://2gis.ru/moscow/firm/123456', 'https://www.openstreetmap.org/node/123456']) assert.ok(directoryReference(url));
  for (const url of ['https://yandex.ru/maps/?text=service', 'https://2gis.ru/moscow/search/автосервис', 'https://yandex.ru.evil.example/maps/org/test/123/',
    'https://2gis.ru/moscow/geo/123456', 'https://yandex.ru/maps/-/synthetic', 'javascript:alert(1)', 'https://user:password@2gis.ru/moscow/firm/123456']) assert.equal(directoryReference(url), null);
});
test('source links retain exact published URL, provenance and unverified status; no directory URL guessed from name', () => {
  const r = fixture(); r.row.evidence[0].tags['contact:website'] = 'https://2gis.ru/moscow/firm/123456?utm_source=synthetic';
  const refs = sourceReferences(r); assert.equal(refs[0].url, r.row.evidence[0].tags['contact:website']);
  assert.equal(refs[0].verification, 'not_checked'); assert.equal(refs[0].evidence[0].type, 'saved_tag');
  assert.equal(sourceReferences(fixture()).filter(r => r.kind === 'directory').length, 0);
});
test('links from unconfirmed websites are never attributed to the organization', () => {
  const r = fixture(); r.checks = [{ status: 'unverified', pages: [{ url: 'https://synthetic.example.org', directoryReferences: [{ url: 'https://2gis.ru/moscow/firm/123456' }] }] }];
  assert.equal(sourceReferences(r).some(x => x.kind === 'directory'), false);
  r.checks[0].status = 'confirmed'; assert.equal(sourceReferences(r).some(x => x.kind === 'directory'), true);
});
test('compact report hides phones/addresses, escapes markup, and never claims no website from empty OSM', () => {
  const r = fixture(); r.row.name = '<img src=x onerror=alert(1)>'; r.row.address = 'SYNTHETIC ADDRESS';
  const html = compactReport({}, [r]);
  assert.doesNotMatch(html, /\+7 000|SYNTHETIC ADDRESS|<img src=x/);
  assert.match(html, /&lt;img/); assert.match(html, /отсутствие сайта не установлено/); assert.match(html, /исходный объект OpenStreetMap/);
  assert.doesNotMatch(html, /Сайт не обнаружен\./);
});
test('only confirmed concrete issues appear as problems; blocking, wrong identity and missing viewport alone do not', () => {
  const r = fixture(); r.checks = [{ status: 'unverified', issues: [{ code: 'overflow', label: 'Synthetic overflow' }] }];
  r.decision.code = 'unverified'; assert.equal(prospect(r).problems.length, 0);
  r.decision.code = 'confirmed'; r.checks[0].status = 'confirmed'; assert.equal(prospect(r).group, 'issues');
  r.checks[0].issues[0].code = 'viewport'; assert.equal(prospect(r).group, 'other');
  r.decision.code = 'ambiguous'; assert.equal(prospect(r).problems.length, 0);
});
test('internal link selection stays on content pages, excludes actions and stops at two URLs', () => {
  const root = 'https://synthetic.example.org/';
  assert.deepEqual(internalTargets(root, [root+'services?delete=1', root+'services/logout', 'https://external.example.org/about', root+'about', root+'services', root+'prices']), [root+'about', root+'services']);
});
test('offline report reads an existing audit, keeps its date and preserves every input byte without dependencies/network', async t => {
  const root = await temporary(t), old = join(root, 'outputs', 'base-audit-2026-01-01'); await mkdir(old, { recursive: true });
  const r = fixture(); r.checkedAt = '2026-01-01T00:00:00Z';
  const input = JSON.stringify([r]); await writeFile(join(old, 'audit.json'), input); await writeFile(join(old, 'report.json'), '{}');
  const result = await reformatSavedReport(root);
  assert.equal(result.count, 1); assert.equal(await readFile(join(old, 'audit.json'), 'utf8'), input);
  assert.match(await readFile(join(result.output, 'report.html'), 'utf8'), /2026-01-01T00:00:00Z/);
  assert.equal(JSON.parse(await readFile(join(result.output, 'origin.json'), 'utf8')).mode, 'offline_reformat');
});
test('default region covers Moscow and oblast administrative areas; legacy cities remain explicit options', () => {
  assert.deepEqual(parseArgs([]).cities, MOSCOW_AREAS);
  assert.deepEqual(parseArgs(['--cities', 'Тверь,Тула']).cities, CITIES.slice(0, 2));
  for (const city of MOSCOW_AREAS) { const query = queryFor(city); assert.match(query, /area.region/); assert.match(query, /\.region out count/); assert.doesNotMatch(query, /around:/); }
});
test('Moscow oblast record outside capital keeps its actual town and is not rejected for a different city name', () => {
  const r = normalizeElement(element(1, { 'addr:city': 'Серпухов' }, { lat: 54.92, lon: 37.41 }), MOSCOW_AREAS[1], timestamp);
  assert.equal(r.geoWarning, ''); assert.equal(r.cityInSource, 'Серпухов'); assert.equal(r.searchScope.wikidata, 'Q1697');
});
test('area absence is failed, not successful empty regional coverage; valid sentinel is excluded from company totals', async t => {
  const root = await temporary(t); const options = { root, cities: [MOSCOW_AREAS[1]], interval: 0, log: () => {} };
  const bad = await run({ ...options, fetchImpl: async () => response(payload([])) });
  assert.equal(bad.report.status, 'failed'); assert.equal(bad.report.cities[0].code, 'AREA_NOT_RESOLVED');
  const good = await run({ ...options, root: await temporary(t), fetchImpl: async () => response(payload([
    { type: 'count', id: 0, tags: { nodes: '0', ways: '0', relations: '0', areas: '1', total: '1' } },
    element(2, { 'addr:city': 'Серпухов' }, { lat: 54.92, lon: 37.41 })])) });
  assert.equal(good.report.status, 'complete'); assert.equal(good.report.rawCount, 1);
  assert.match(await readFile(join(good.output, 'report.html'), 'utf8'), /OpenStreetMap/);
});
