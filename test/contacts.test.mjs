import test from 'node:test';
import assert from 'node:assert/strict';
import { availableContacts, contactFields, linkContact } from '../src/audit/contacts.mjs';
import { normalizeElement } from '../src/model.mjs';
import { CITIES } from '../src/config.mjs';
import { element, timestamp } from './helpers.mjs';
import { decide, auditCsv, auditQueue } from '../src/audit/run.mjs';
import { discover } from '../src/audit/matching.mjs';
const row = tags => normalizeElement(element(1, tags), CITIES[0], timestamp);

test('legacy evidence recovers explicit MAX and Telegram handles without fabricating URLs', () => {
  const r = row({ 'contact:max': 'https://max.ru/synthetic-test', 'contact:telegram': '@synthetic_test', 'contact:vk': 'https://vk.com/synthetic_test' });
  const fields = contactFields(r);
  assert.equal(fields.max, 'https://max.ru/synthetic-test');
  assert.equal(fields.telegram, '@synthetic_test');
  assert.equal(fields.vk, 'https://vk.com/synthetic_test');
  assert.equal(availableContacts(r).find(c => c.channel === 'max').evidence[0].sourceUrl, r.sources[0]);
});
test('a MAX-only legacy organization can enter the audit queue without a new Overpass request', () => {
  const r = row({ phone: '', 'contact:max': 'https://max.ru/synthetic-test' });
  assert.equal(r.socials.length, 0);
  assert.equal(auditQueue([r], 5).length, 1);
});
test('website contacts are added only for a confirmed match, retaining evidence URL', () => {
  const r = row({});
  const pages = [{ url: 'https://business.example.org/contacts', contacts: [{ channel: 'email', value: 'office@example.org' }] }];
  assert.equal(contactFields(r, [{ status: 'unverified', pages }]).email, '');
  assert.equal(contactFields(r, [{ status: 'confirmed', pages }]).email, 'office@example.org');
  assert.equal(availableContacts(r, [{ status: 'confirmed', pages }]).find(c => c.channel === 'email').evidence[0].sourceUrl, pages[0].url);
});
test('contact URLs exclude unsafe schemes and credentials, email subject is not a contact', () => {
  assert.deepEqual(linkContact('mailto:office@example.org?subject=hello'), { channel: 'email', value: 'office@example.org' });
  assert.equal(linkContact('https://user:secret@max.ru/test'), null);
  assert.equal(linkContact('javascript:alert(1)'), null);
  assert.equal(linkContact('https://max.ru.evil.example/org'), null);
  assert.equal(linkContact('https://max.ru/test').channel, 'max');
});
test('malformed existing website is not reported as a new-site prospect', () => {
  const r = row({ website: 'ссылка требует проверки' });
  const found = discover(r, { status: 'ok', data: { features: [] } });
  assert.equal(decide(found, []).code, 'unverified');
  assert.equal(decide(found, []).priority, 0);
});
test('CSV separates contact channels, observations, assumptions and errors', () => {
  const r = row({ 'contact:max': 'https://max.ru/synthetic-test' });
  const discovery = discover(r, { status: 'unavailable' });
  const result = { row: r, checks: [], discovery, decision: decide(discovery, []), evidenceFile: 'evidence/org-1.json', checkedAt: new Date(timestamp).toISOString() };
  const csv = auditCsv([result]);
  for (const column of ['Телефон', 'Email', 'ВКонтакте', 'Telegram', 'MAX', 'Подтверждённые наблюдения', 'Предположения', 'Ошибки и ограничения']) assert.ok(csv.includes(`"${column}"`));
  assert.match(csv, /https:\/\/max.ru\/synthetic-test/);
  assert.match(csv, /Независимый поиск недоступен/);
});
