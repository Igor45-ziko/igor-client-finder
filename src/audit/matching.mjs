import { normalizeName, phoneKey, websiteUrl, distance } from '../model.mjs';

const generic = new Set(['автосервис', 'автосервисы', 'автомастерская', 'сто', 'сервис', 'авто', 'service', 'auto', 'repair', 'ооо', 'ип', 'центр', 'технический', 'техцентр']);
export const distinctive = name => normalizeName(name).split(' ').filter(t => t.length >= 3 && !generic.has(t) && !/^\d+$/.test(t));
export function nameMatches(name, text) {
  const tokens = distinctive(name); const hay = normalizeName(text);
  return tokens.length > 0 && tokens.filter(t => hay.split(' ').includes(t)).length / tokens.length >= 0.8;
}
const values = a => Array.isArray(a) ? a.filter(x => typeof x === 'string') : [];
const phoneKeys = text => [...String(text).matchAll(/\+?\d[\d\s().-]{7,}\d/g)].map(x => phoneKey(x[0])).filter(Boolean);
export function addressMatches(row, text) {
  const street = normalizeName(row.street || '').split(' ').filter(x => !['улица', 'ул', 'проспект', 'пр', 'переулок', 'пер', 'шоссе'].includes(x));
  const hay = normalizeName(text); const house = normalizeName(row.house || '');
  if (!street.length || !house) return false;
  const needle = street.join(' ');
  let index = hay.indexOf(needle);
  while (index >= 0) {
    // A house number in an unrelated footer/price must not confirm this street.
    const nearby = hay.slice(Math.max(0, index - 25), index + needle.length + 60).split(' ');
    if (nearby.includes(house)) return true;
    index = hay.indexOf(needle, index + needle.length);
  }
  return false;
}
export function siteEvidence(row, text) {
  const keys = phoneKeys(text);
  const phone = (row.phones || []).some(x => keys.includes(x.key));
  const publishedEmails = (String(text).toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []);
  const email = (row.emails || []).some(x => publishedEmails.includes(x.key.toLowerCase()));
  const name = nameMatches(row.name, text);
  const address = addressMatches(row, text);
  const city = [row.cityInSource, ...(row.searchCities || [])].filter(Boolean).some(x => normalizeName(text).includes(normalizeName(x)));
  const confirmed = ((phone || email) && (name || address)) || (name && address && city);
  return { confirmed, name, phone, email, address, city,
    matched: [name && 'название', phone && 'телефон', email && 'email', address && 'улица и дом', city && 'город'].filter(Boolean) };
}

export function matchOverture(row, feature) {
  const p = feature.properties; const coordinates = feature.geometry.coordinates;
  const d = distance(row, { lon: coordinates[0], lat: coordinates[1] });
  if (d > 1500 || p.operating_status === 'permanently_closed') return null;
  const name = p.names?.primary || '';
  const sameName = nameMatches(row.name, name);
  const phones = values(p.phones).map(phoneKey);
  const phone = (row.phones || []).some(x => phones.includes(x.key));
  const addresses = (p.addresses || []).map(x => [x.freeform, x.locality, x.postcode].filter(Boolean).join(' ')).join(' | ');
  const address = addressMatches(row, addresses);
  if (!(phone && (sameName || address || d <= 100)) && !(sameName && (address || d <= 150))) return null;
  return { id: p.id || feature.id || '', name, distanceMeters: Math.round(d), phone, address, sameName,
    websites: values(p.websites).map(websiteUrl).filter(Boolean), providerSources: p.sources || [] };
}

const mailProviders = new Set(['gmail.com', 'googlemail.com', 'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'yandex.ru', 'ya.ru', 'yandex.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'rambler.ru', 'proton.me', 'protonmail.com']);
const directories = ['vk.com', 'vk.ru', 't.me', 'telegram.me', 'max.ru', 'wa.me', 'whatsapp.com', 'instagram.com', 'facebook.com', '2gis.ru', 'yandex.ru', 'yandex.com', 'avito.ru', 'zoon.ru', 'google.com'];
export function isDirectory(url) {
  const host = new URL(url).hostname.toLowerCase();
  return directories.some(d => host === d || host.endsWith('.' + d));
}
export function discover(row, overture) {
  const candidates = new Map(); const directoryLinks = []; const unresolvedReferences = [];
  const add = (url, source) => {
    const raw = url; url = websiteUrl(url);
    if (!url) { unresolvedReferences.push({ raw, source }); return; }
    if (isDirectory(url)) { directoryLinks.push({ url, source }); return; }
    const u = new URL(url); u.hash = '';
    // Preserve different paths; company pages on a shared host may belong to different firms.
    const key = u.href;
    if (!candidates.has(key)) candidates.set(key, { url: key, sources: [] });
    candidates.get(key).sources.push(source);
  };
  for (const url of row.rawWebsites || []) add(url, { type: 'osm', urls: row.sources });
  for (const email of row.emails || []) {
    const domain = email.key.split('@')[1]?.toLowerCase();
    if (domain && !mailProviders.has(domain)) add(`https://${domain}/`, { type: 'email-domain', email: email.raw, urls: row.sources });
  }
  const matches = [];
  if (overture?.status === 'ok') for (const f of overture.data.features) {
    const match = matchOverture(row, f); if (!match) continue;
    matches.push(match);
    for (const url of match.websites) add(url, { type: 'overture', sourceUrl: overture.sourceUrl, release: overture.release,
      recordId: match.id, match, fetchedAt: new Date(overture.fetchedAt).toISOString() });
  }
  // Independent matches first; never let an OSM-only link masquerade as new discovery.
  return { candidates: [...candidates.values()].sort((a, b) => Number(b.sources.some(x => x.type === 'overture')) - Number(a.sources.some(x => x.type === 'overture'))),
    directoryLinks, unresolvedReferences, matches, sourceUrl: overture?.sourceUrl, independentStatus: overture?.status || 'unavailable' };
}
