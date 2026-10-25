import { ATTRIBUTION } from './config.mjs';

const unique = values => [...new Set(values.filter(Boolean))];
const clean = value => typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 3000) : '';
export const normalizeName = value => clean(value).toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const split = value => clean(value).split(/[;,]/).map(x => x.trim()).filter(Boolean);

export function phoneKey(value) {
  const number = value.replace(/^tel:/i, '').replace(/(?:доб\.?|ext\.?|#).*$/i, '').replace(/\D/g, '');
  if (number.length === 11 && number.startsWith('8')) return '7' + number.slice(1);
  if (number.length === 10) return '7' + number;
  return number.length >= 11 && number.length <= 15 ? number : '';
}

export function websiteUrl(value) {
  try {
    const raw = clean(value);
    if (!raw || /\s/.test(raw)) return '';
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return '';
    return url.href;
  } catch { return ''; }
}

function contacts(tags, fields, validate) {
  return unique(fields.flatMap(field => split(tags[field]))).map(raw => ({ raw, key: validate(raw) })).filter(x => x.key);
}

export function distance(a, b) {
  if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return Infinity;
  const r = Math.PI / 180;
  const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - Math.min(1, x)));
}

export function normalizeElement(element, city, fetchedAt) {
  const tags = element.tags;
  if (tags.shop !== 'car_repair') return null;
  if (['disused', 'abandoned', 'demolished', 'removed', 'closed'].some(key => /^(yes|true|1)$/i.test(tags[key] || ''))) return null;
  const source = `https://www.openstreetmap.org/${element.type}/${element.id}`;
  const name = clean(tags['name:ru'] || tags.name || tags.brand || tags.operator);
  const rawWebsites = unique(['website', 'contact:website', 'url'].flatMap(key => split(tags[key])));
  const phones = contacts(tags, ['phone', 'contact:phone', 'mobile', 'contact:mobile'], phoneKey);
  const emails = contacts(tags, ['email', 'contact:email'], raw => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.replace(/^mailto:/i, '')) ? raw.replace(/^mailto:/i, '').toLowerCase() : '');
  const socials = contacts(tags, ['contact:vk', 'contact:telegram', 'contact:whatsapp'], websiteUrl);
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  const cityInSource = clean(tags['addr:city']);
  const address = unique([tags['addr:full'], tags['addr:postcode'], cityInSource,
    tags['addr:suburb'], tags['addr:street'] || tags['addr:place'], tags['addr:housenumber']].map(clean)).join(', ');
  const row = {
    name, searchCities: [city.name], cityInSource, address,
    street: clean(tags['addr:street'] || tags['addr:place']), house: clean(tags['addr:housenumber']),
    lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null,
    phones, emails, socials, rawWebsites,
    websites: unique(rawWebsites.map(websiteUrl)),
    sourceIds: [`${element.type}/${element.id}`], sources: [source],
    evidence: [{ source, fetchedAt: new Date(fetchedAt).toISOString(), tags }],
    geoWarning: cityInSource && normalizeName(cityInSource.replace(/^г\.?\s*/i, '')) !== normalizeName(city.name)
      ? 'В адресе OSM указан другой населённый пункт; требуется проверка.' : '',
  };
  if (Number.isFinite(lat) && Number.isFinite(lon) && distance(row, city) > city.radius + 500)
    row.geoWarning = 'Центр объекта за пределами зоны поиска; требуется проверка.';
  return row;
}

function sameBusiness(a, b) {
  if (a.sourceIds.some(id => b.sourceIds.includes(id))) return true;
  const name = normalizeName(a.name);
  if (!name || name !== normalizeName(b.name)) return false;
  const d = distance(a, b);
  // A shared central phone/domain never collapses branches at different locations.
  if (d > 120 && d !== Infinity) return false;
  const sameAddress = a.street && a.house && a.cityInSource &&
    normalizeName(a.street) === normalizeName(b.street) && normalizeName(a.house) === normalizeName(b.house) &&
    normalizeName(a.cityInSource) === normalizeName(b.cityInSource);
  if (sameAddress) return true;
  const keys = row => [...row.phones, ...row.emails].map(x => x.key);
  const sharedContact = keys(a).some(key => keys(b).includes(key));
  return d <= 60 && sharedContact;
}

function merge(a, b) {
  for (const key of ['searchCities', 'rawWebsites', 'websites', 'sourceIds', 'sources']) a[key] = unique([...a[key], ...b[key]]);
  for (const key of ['phones', 'emails', 'socials']) {
    const map = new Map([...a[key], ...b[key]].map(x => [x.key, x])); a[key] = [...map.values()];
  }
  a.evidence.push(...b.evidence);
  for (const key of ['name', 'address', 'street', 'house', 'cityInSource', 'geoWarning']) a[key] ||= b[key];
  return a;
}

export function deduplicate(rows) {
  const result = [];
  for (const row of rows) {
    // Preserve raw input records; every merged field remains traceable in evidence.
    const copy = structuredClone(row);
    const existing = result.find(x => sameBusiness(x, copy));
    if (existing) merge(existing, copy); else result.push(copy);
  }
  return result;
}

export function classify(row) {
  const siteStatus = row.rawWebsites.length ? (row.websites.length ? 'Указан в OSM; принадлежность и работа не проверены' : 'Поле сайта заполнено, ссылка требует проверки') : 'Сайт не указан в OSM; отсутствие сайта не подтверждено';
  const contact = row.phones.length + row.emails.length + row.socials.length > 0;
  const eligible = Boolean(row.name && contact && !row.rawWebsites.length && !row.geoWarning);
  const reason = !row.name ? 'В OSM нет названия; нужна ручная проверка.' : row.geoWarning ||
    (!contact ? 'Нет распознанного опубликованного контакта.' :
      row.rawWebsites.length ? 'Сайт или ссылка указаны; аудит сайта ещё не выполнен.' :
        'Есть опубликованный контакт, сайт в OSM не указан. Уточнить наличие сайта и актуальность организации.');
  return { siteStatus, eligible, reason, score: eligible ? 10 + (row.phones.length ? 2 : 0) + (row.emails.length ? 2 : 0) + (row.address ? 1 : 0) : 0 };
}

export function selectLeads(rows, target) {
  return rows.filter(row => classify(row).eligible).sort((a, b) => classify(b).score - classify(a).score || a.name.localeCompare(b.name, 'ru')).slice(0, target);
}

// Quote every cell and neutralise spreadsheet formulas, including leading controls.
export function csvCell(value) {
  let text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (/^[\s\uFEFF]*[=+@-]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

const HEADERS = ['Название', 'Зона поиска', 'Город в OSM', 'Адрес в OSM', 'Статус сайта', 'Сайты из OSM',
  'Телефоны из OSM', 'Email из OSM', 'Соцсети из OSM', 'Причина отбора / проверки',
  'Координаты', 'Источники OSM', 'Даты получения данных UTC', 'Проверка контактов', 'Атрибуция'];

export function toCsv(rows) {
  const lines = [HEADERS, ...rows.map(row => [row.name || '(название не указано)', row.searchCities.join(' | '),
    row.cityInSource || 'Не указан; поиск включает окрестности', row.address,
    classify(row).siteStatus, row.rawWebsites.join(' | '), row.phones.map(x => x.raw).join(' | '),
    row.emails.map(x => x.raw).join(' | '), row.socials.map(x => x.raw).join(' | '), classify(row).reason,
    row.lat === null || row.lon === null ? '' : `${row.lat}, ${row.lon}`, row.sources.join(' | '),
    unique(row.evidence.map(x => x.fetchedAt)).join(' | '), 'Опубликованы в OSM; принадлежность и актуальность не подтверждены', ATTRIBUTION])];
  return '\uFEFF' + lines.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
