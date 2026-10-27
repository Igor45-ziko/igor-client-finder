import test from 'node:test';
import assert from 'node:assert/strict';
import { trialQuery, trialRows, observedCards, trialStatus, renderTrial } from '../probe-card-links.mjs';
import { MOSCOW_AREAS } from '../src/config.mjs';

// All objects/IDs here are synthetic. Never included in trial data or runtime ZIPs.
const area = MOSCOW_AREAS[1];
const sentinel = { type: 'count', id: 0, tags: { areas: '1', total: '1' } };
const payload = tags => ({ elements: [sentinel, { type: 'node', id: 123, lat: 55.4, lon: 37.1, tags: { shop: 'car_repair', name: 'Synthetic only', ...tags } }] });
const row = tags => trialRows(payload(tags), area, 0)[0];
test('trial query covers administrative Moscow and entire oblast, with bounded response', () => {
  for (const a of MOSCOW_AREAS) {
    const q = trialQuery(a); assert.ok(q.includes(a.areaWikidata));
    assert.match(q, /timeout:20/); assert.match(q, /out body center 20/); assert.doesNotMatch(q, /around:/);
  }
  assert.throws(() => trialQuery({ areaWikidata: 'Q0' }), /UNKNOWN_AREA/);
});
test('trial refuses missing or ambiguous boundary and preserves regional provenance', () => {
  assert.throws(() => trialRows({ elements: [] }, area, 0), /AREA_NOT_RESOLVED/);
  assert.throws(() => trialRows({ elements: [sentinel, sentinel] }, area, 0), /AREA_NOT_RESOLVED/);
  assert.equal(row({ 'addr:city': 'Серпухов' }).cityInSource, 'Серпухов');
  assert.equal(row({}).searchScope.wikidata, 'Q1697');
});
test('only already published card URLs retained, no OSM/search links or manufactured IDs', () => {
  assert.deepEqual(observedCards(row({})), []);
  const r = row({ 'contact:yandex': 'https://yandex.ru/maps/org/synthetic/123456/' });
  const found = observedCards(r); assert.equal(found.length, 1);
  assert.equal(found[0].url, r.evidence[0].tags['contact:yandex']);
  assert.equal(found[0].verification, 'not_checked');
  assert.deepEqual(observedCards(row({ website: 'https://yandex.ru/maps/?text=synthetic' })), []);
});
test('links from unconfirmed sites never acquire company ownership', () => {
  const c = { status: 'unverified', pages: [{ url: 'https://synthetic.example.org/', directoryReferences: [{ url: 'https://2gis.ru/moscow/firm/123456' }] }] };
  assert.equal(observedCards(row({}), [c]).length, 0);
  c.status = 'confirmed'; assert.equal(observedCards(row({}), [c])[0].verification, 'not_checked');
});
test('network error/no candidate is never no-site or site fault evidence', () => {
  for (const checks of [[], [{ status: 'unavailable', issues: [{ code: 'home_404', label: 'fake fault' }] }]]) {
    assert.match(trialStatus(checks), /не установлен/);
    assert.doesNotMatch(trialStatus(checks), /fake fault|сайт не обнаружен|Сайт отсутствует/i);
  }
});
test('four defect types only and only after identity confirmation', () => {
  for (const code of ['overflow', 'home_404', 'contact_404', 'image_404', 'link_404'])
    assert.match(trialStatus([{ status: 'confirmed', issues: [{ code, label: 'observed defect' }] }]), /observed defect/);
  assert.doesNotMatch(trialStatus([{ status: 'confirmed', issues: [{ code: 'viewport', label: 'no viewport' }] }]), /no viewport/);
});
test('HTML only lists rows with actual cards, escapes names, labels manual validation and no independent search', () => {
  const a = row({ 'contact:yandex': 'https://yandex.ru/maps/org/synthetic/123456/' });
  a.name = '<script>synthetic</script>'; a.address = 'SECRET-ADDRESS';
  const html = renderTrial({ results: [{ row: a, checks: [], cards: observedCards(a) }, { row: row({ name: 'NO-CARD-ROW' }), checks: [], cards: [] }], notes: [] });
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|SECRET-ADDRESS|NO-CARD-ROW/);
  assert.match(html, /филиал не проверены/); assert.match(html, /Независимый поиск отсутствующих сайтов не выполнен/);
});
