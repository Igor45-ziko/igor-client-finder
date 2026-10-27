import test from 'node:test';
import assert from 'node:assert/strict';
import { CITIES, parseArgs, queryFor } from '../src/config.mjs';
import { normalizeElement, deduplicate, classify, selectLeads, toCsv, csvCell, phoneKey, websiteUrl } from '../src/model.mjs';
import { element, timestamp } from './helpers.mjs';

const row = (id = 1, tags = {}, extra = {}) => normalizeElement(element(id, tags, extra), CITIES[0], timestamp);

test('search is driven by geography/category, not a provided company list', () => {
  const query = queryFor(CITIES[0]);
  assert.match(query, /nwr\["shop"="car_repair"\]/);
  assert.match(query, /around:12000,56\.8587,35\.9176/);
  assert.doesNotMatch(query, /\["name"/);
  assert.match(query, /timeout:25/);
});
test('CLI has bounded targets and rejects unknown cities/options', () => {
  assert.equal(parseArgs([]).target, 20);
  assert.equal(parseArgs(['--cities', 'Тула,Тула,Рязань', '--target', '5']).cities.length, 2);
  for (const args of [['--target', '0'], ['--target', '21'], ['--target', 'NaN'], ['--target', '2.5'], ['--cities', 'Неизвестный город'], ['--send']])
    assert.throws(() => parseArgs(args));
});
test('missing website is never described as a verified absence', () => {
  const r = row();
  assert.equal(classify(r).eligible, true);
  assert.match(classify(r).siteStatus, /отсутствие сайта не подтверждено/);
  assert.equal(r.sources[0], 'https://www.openstreetmap.org/node/1');
  assert.equal(r.evidence[0].fetchedAt, new Date(timestamp).toISOString());
});
test('website aliases and malformed websites do not become no-website leads', () => {
  for (const tags of [{ website: 'https://example.org' }, { 'contact:website': 'example.org' }, { url: 'сломанная ссылка' }]) {
    const r = row(1, tags);
    assert.equal(classify(r).eligible, false);
    assert.equal(r.rawWebsites.length, 1);
  }
});
test('contacts are extracted from alternate fields and retain their source values', () => {
  const r = row(1, { phone: '', 'contact:phone': '+7 (000) 000-00-01; 8 (000) 000-00-02', 'contact:email': 'service@example.org',
    'contact:vk': 'https://vk.com/example', 'contact:website': 'example.org' });
  assert.equal(r.phones.length, 2);
  assert.equal(r.emails[0].key, 'service@example.org');
  assert.equal(r.socials.length, 1);
  assert.equal(r.websites[0], 'https://example.org/');
  assert.equal(r.evidence[0].tags['contact:phone'], '+7 (000) 000-00-01; 8 (000) 000-00-02');
});
test('bad contact values, unnamed and explicitly closed businesses are not leads', () => {
  assert.equal(classify(row(1, { phone: 'нет', email: 'не email' })).eligible, false);
  assert.equal(classify(row(1, { name: '' })).eligible, false);
  assert.equal(row(1, { disused: 'yes' }), null);
  assert.equal(row(1, { shop: 'tyres' }), null);
});
test('other settlements and out-of-area geometry require review', () => {
  assert.equal(classify(row(1, { 'addr:city': 'Другой город' })).eligible, false);
  assert.equal(classify(row(2, {}, { lat: 58, lon: 35 })).eligible, false);
  assert.equal(classify(row(3, { 'addr:city': 'г. Тверь' })).eligible, true);
});
test('node and building duplicate merge contacts, websites and provenance', () => {
  const a = row();
  const b = row(2, { website: 'https://example.org' }, { type: 'way', lat: undefined, lon: undefined, center: { lat: CITIES[0].lat, lon: CITIES[0].lon } });
  const merged = deduplicate([a, b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sources.length, 2);
  assert.equal(merged[0].evidence.length, 2);
  assert.equal(classify(merged[0]).eligible, false);
  assert.equal(a.sources.length, 1, 'input objects were not mutated');
});
test('network branches with same name, phone and website remain separate', () => {
  const a = row(1, { website: 'https://example.org' });
  const b = row(2, { website: 'https://example.org' }, { lat: CITIES[0].lat + 0.02 });
  assert.equal(deduplicate([a, b]).length, 2);
});
test('same address and name merge without depending on a shared phone', () => {
  const addr = { 'addr:city': 'Тверь', 'addr:street': 'Тестовая', 'addr:housenumber': '1' };
  assert.equal(deduplicate([row(1, addr), row(2, { ...addr, phone: '', email: 'service@example.org' })]).length, 1);
});
test('generic nearby names without common contacts are not merged', () => {
  assert.equal(deduplicate([row(1, { name: 'Автосервис', phone: '' }), row(2, { name: 'Автосервис', phone: '' })]).length, 2);
});
test('exact OSM ID deduplicates overlapping geographical queries', () => {
  const a = row(); const b = structuredClone(a); b.searchCities = ['Тула'];
  const merged = deduplicate([a, b]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].searchCities, ['Тверь', 'Тула']);
});
test('selection never pads target with organizations lacking contacts or with a website', () => {
  const rows = [row(1), row(2, { phone: '' }), row(3, { website: 'example.org' })];
  assert.equal(selectLeads(rows, 20).length, 1);
  assert.equal(selectLeads([row(1), row(2)], 1).length, 1);
});
test('CSV supports Russian Excel, semicolons, quotes and protects formula cells', () => {
  const csv = toCsv([row(1, { name: '=HYPERLINK("https://example.org";"x")' })]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /\r\n/);
  assert.match(csv, /"'=HYPERLINK/);
  assert.match(csv, /"'\+7 000/);
  assert.match(csv, /© OpenStreetMap contributors/);
  assert.equal(csvCell(' \t=1+1'), '"\' \t=1+1"');
  assert.equal(csvCell('a;"b"'), '"a;""b"""');
});
test('normalisation does not accept dangerous URLs or fabricate short phone numbers', () => {
  assert.equal(phoneKey('8 (4822) 123-456'), '74822123456');
  assert.equal(phoneKey('123'), '');
  assert.equal(websiteUrl('javascript:alert(1)'), '');
  assert.equal(websiteUrl('https://user:password@example.org'), '');
  assert.equal(websiteUrl('пример.рф').startsWith('https://xn--'), true);
});
