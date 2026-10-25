import { phoneKey } from '../model.mjs';

export const CHANNELS = ['phone', 'email', 'vk', 'telegram', 'max', 'whatsapp', 'other'];
export const CHANNEL_LABELS = { phone: 'Телефон', email: 'Email', vk: 'ВКонтакте', telegram: 'Telegram', max: 'MAX', whatsapp: 'WhatsApp', other: 'Другие контакты' };
const hosts = { vk: ['vk.com', 'vk.ru'], telegram: ['t.me', 'telegram.me'], max: ['max.ru'], whatsapp: ['wa.me', 'api.whatsapp.com', 'whatsapp.com'] };

export function linkContact(href) {
  if (typeof href !== 'string') return null;
  try {
    if (/^tel:/i.test(href)) {
      const value = decodeURIComponent(href.slice(4)).trim();
      return phoneKey(value) ? { channel: 'phone', value } : null;
    }
    if (/^mailto:/i.test(href)) {
      const value = decodeURIComponent(href.slice(7).split('?')[0]).trim();
      return /^[^\s@,;]+@[^\s@]+\.[^\s@]+$/.test(value) ? { channel: 'email', value } : null;
    }
    const url = new URL(href);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    for (const [channel, domains] of Object.entries(hosts))
      if (domains.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) return { channel, value: url.href };
  } catch { /* Do not guess handles or repair malformed URLs. */ }
  return null;
}

export function availableContacts(row, checks = []) {
  const contacts = [];
  const add = (channel, value, sourceUrl, verification) => {
    if (typeof value !== 'string' || !value.trim()) return;
    value = value.trim();
    const key = channel === 'phone' ? phoneKey(value) || value : value.toLowerCase();
    const existing = contacts.find(c => c.channel === channel && c.key === key);
    const evidence = { sourceUrl, verification };
    if (existing) {
      if (!existing.evidence.some(e => e.sourceUrl === sourceUrl && e.verification === verification)) existing.evidence.push(evidence);
    } else contacts.push({ channel, value, key, evidence: [evidence] });
  };
  for (const item of row.phones || []) add('phone', item.raw, row.sources?.[0], 'Опубликован в OSM; актуальность не подтверждена');
  for (const item of row.emails || []) add('email', item.raw, row.sources?.[0], 'Опубликован в OSM; актуальность не подтверждена');
  for (const item of row.socials || []) {
    const match = linkContact(item.raw);
    add(match?.channel || 'other', match?.value || item.raw, row.sources?.[0], 'Опубликован в OSM; актуальность не подтверждена');
  }
  // v0.1 saved all original tags. Recover MAX and explicit handles without re-querying OSM.
  for (const entry of row.evidence || []) for (const channel of ['vk', 'telegram', 'max', 'whatsapp']) {
    for (const field of [`contact:${channel}`, channel]) {
      const raw = entry.tags?.[field];
      if (typeof raw === 'string') for (const value of raw.split(';'))
        add(channel, value, entry.source, 'Явно указанное поле OSM; актуальность не подтверждена');
    }
  }
  // Never attribute contacts of a lookalike/unavailable site to the company.
  for (const check of checks.filter(c => c.status === 'confirmed')) for (const page of check.pages || [])
    for (const item of page.contacts || []) add(item.channel, item.value, page.url, 'Опубликован на сайте с подтверждённым совпадением данных; доставка не проверялась');
  return contacts;
}

export function contactFields(row, checks = []) {
  const contacts = availableContacts(row, checks);
  return Object.fromEntries(CHANNELS.map(channel => [channel, contacts.filter(c => c.channel === channel).map(c => c.value).join(' | ')]));
}
