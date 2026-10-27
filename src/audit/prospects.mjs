// Only recognise URLs actually present in saved records or inspected pages.
// Never manufacture directory IDs or turn search/geographic URLs into company cards.
export function directoryReference(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (['yandex.ru', 'yandex.com', 'yandex.by', 'yandex.kz'].includes(host) && /^\/maps\/org\/(?:[^/]+\/)?\d+\/?$/.test(u.pathname))
      return { url: u.href, provider: 'Яндекс Карты', kind: 'directory' };
    if (host === '2gis.ru' && /^\/[^/]+\/firm\/\d+\/?$/.test(u.pathname))
      return { url: u.href, provider: '2ГИС', kind: 'directory' };
    if (host === 'openstreetmap.org' && /^\/(node|way|relation)\/\d+\/?$/.test(u.pathname))
      return { url: u.href, provider: 'OpenStreetMap', kind: 'osm' };
  } catch { /* Unrecognised references stay unverified; never repair or guess IDs. */ }
  return null;
}

export function sourceReferences(result) {
  const found = new Map();
  const add = (raw, evidence) => {
    const ref = directoryReference(raw); if (!ref) return;
    if (!found.has(ref.url)) found.set(ref.url, { ...ref, evidence: [], verification: 'not_checked' });
    found.get(ref.url).evidence.push(evidence);
  };
  const row = result.row;
  for (const raw of [...(row.rawWebsites || []), ...(row.sources || []), ...(row.socials || []).map(x => x.raw)])
    add(raw, { type: 'saved_record', sourceUrl: row.sources?.[0] });
  for (const entry of row.evidence || []) for (const value of Object.values(entry.tags || {}))
    if (typeof value === 'string') for (const raw of value.split(';')) add(raw.trim(), { type: 'saved_tag', sourceUrl: entry.source, fetchedAt: entry.fetchedAt });
  for (const check of result.checks || []) if (check.status === 'confirmed')
    for (const page of check.pages || []) for (const ref of page.directoryReferences || [])
      add(ref.url, { type: 'confirmed_website_link', sourceUrl: page.url, checkedAt: check.checkedAt });
  return [...found.values()].sort((a, b) => Number(a.kind === 'osm') - Number(b.kind === 'osm'));
}

const problemCodes = new Set(['overflow', 'home_404', 'contact_404', 'image_404', 'link_404']);
export function prospect(result) {
  const refs = sourceReferences(result);
  const confirmed = result.decision?.code === 'confirmed';
  const checks = confirmed ? (result.checks || []).filter(c => c.status === 'confirmed') : [];
  const problems = checks.flatMap(c => (c.issues || []).filter(i => problemCodes.has(i.code)).map(i => ({ ...i, checkedAt: c.checkedAt || result.checkedAt })));
  const candidates = result.discovery?.candidates || [];
  let group, status;
  if (confirmed && problems.length) { group = 'issues'; status = 'Сайт подтверждён. ' + problems.map(i => i.label).join('; '); }
  else if (confirmed) { group = 'other'; status = 'Сайт подтверждён. В проверенном объёме конкретные проблемы из списка не обнаружены.'; }
  else if (result.decision?.code === 'ambiguous') { group = 'review'; status = 'Несколько сайтов совпали с данными. Принадлежность требует ручной проверки.'; }
  else if (candidates.length) { group = 'review'; status = 'Есть сайт-кандидат; принадлежность или доступность проверки не подтверждена. Это не доказательство неисправности сайта.'; }
  else { group = 'review'; status = 'Сайт не подтверждён по сохранённым данным. Независимый поиск не выполнен; отсутствие сайта не установлено.'; }
  return { name: result.row.name || '(название не указано)', refs, primary: refs[0] || null, group, status, problems,
    website: confirmed ? (result.decision.best?.finalUrl || checks[0]?.finalUrl || checks[0]?.candidate?.url) : null,
    candidates: candidates.map(c => c.url), checkedAt: result.checkedAt || '', geoWarning: result.row.geoWarning || '' };
}

const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const link = (url, label) => {
  try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return esc(label); }
  catch { return esc(label); }
  return `<a href="${esc(url)}" target="_blank" rel="noreferrer noopener">${esc(label)}</a>`;
};
export function compactReport(report, results, { detailsUrl = 'details.html' } = {}) {
  const items = results.map(prospect);
  const counts = Object.fromEntries(['issues', 'review', 'other'].map(k => [k, items.filter(i => i.group === k).length]));
  const cards = group => items.filter(i => i.group === group).map(i => `<article>
    <h3>${esc(i.name)}</h3>
    <p>${i.primary ? link(i.primary.url, i.primary.kind === 'directory' ? `Открыть карточку — ${i.primary.provider}` : 'Открыть исходный объект OpenStreetMap') : 'Прямая ссылка на карточку не получена.'}</p>
    ${i.primary ? `<p class="note">${i.primary.kind === 'directory' ? 'Ссылка взята из сохранённых сведений или подтверждённого сайта. Доступность карточки, связь с конкретным филиалом и возможность обращения через неё не проверены.' : 'Это объект исходной базы OSM, а не проверенная действующая карточка Яндекс/2ГИС. Ссылка на коммерческий справочник не получена.'}</p>` : ''}
    <p><strong>Результат:</strong> ${esc(i.status)}</p>
    ${i.website ? `<p>Сайт: ${link(i.website, i.website)}</p>` : ''}
    ${i.problems.length ? `<ul>${i.problems.map(p => `<li>${esc(p.label)} — ${link(p.url, 'проверенный адрес')} ${p.sourceUrl ? '(ссылка со страницы ' + link(p.sourceUrl, 'источник') + ')' : ''}</li>`).join('')}</ul>` : ''}
    ${i.checkedAt ? `<p class="note">Дата проверки: ${esc(i.checkedAt)}. Это наблюдение на указанную дату, не оценка потребности в услуге.</p>` : ''}
    ${i.geoWarning ? `<p class="note">${esc(i.geoWarning)}</p>` : ''}
    ${i.refs.length > 1 || (!i.website && i.candidates.length) ? `<details><summary>Дополнительные ссылки и кандидаты</summary>${i.refs.slice(1).map(r => `<p>${link(r.url, r.provider)} — актуальность не проверена</p>`).join('')}${!i.website ? i.candidates.map(u => `<p>Неподтверждённый сайт: ${link(u, u)}</p>`).join('') : ''}</details>` : ''}
    </article>`).join('') || '<p>Нет записей в этой группе.</p>';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Организации: источник и результат</title>
    <style>body{font:16px/1.6 system-ui;margin:auto;padding:20px;max-width:960px;background:#f4f5f7;color:#17252b}article{background:#fff;border:1px solid #d3dce1;border-radius:12px;padding:18px;margin:16px 0;overflow-wrap:anywhere}h3{margin:0}a{color:#075583}.note{font-size:14px;color:#495965}nav{display:flex;flex-wrap:wrap;gap:16px}summary{cursor:pointer}details{margin:12px 0}</style></head><body>
    <h1>Организация → источник → результат</h1><p>Записей: ${items.length}. С наблюдаемыми проблемами сайта: ${counts.issues}. Требуют уточнения: ${counts.review}.</p>
    <p>Независимый поиск карточек и отсутствующих сайтов в этой версии не выполнен. Нет подтверждённого списка организаций без сайта. Карточки каталогов автоматически не открывались; их актуальность не подтверждена. Ничего не отправлено компаниям.</p>
    ${detailsUrl === 'details.html' ? '<p><a href="details.html">Подробный отчёт и контакты</a></p>' : '<p>Подробный исходный отчёт находится в прежней папке результатов.</p>'}
    ${(report.errors || []).length ? `<details><summary>Ограничения запуска</summary><ul>${report.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
    <nav aria-label="Разделы отчёта"><a href="#issues">Проблемы сайтов (${counts.issues})</a><a href="#review">Нужно уточнить (${counts.review})</a><a href="#other">Остальные (${counts.other})</a></nav>
    <h2 id="issues">Наблюдаемые проблемы подтверждённых сайтов</h2>${cards('issues')}
    <h2 id="review">Нужно уточнить — это не готовый список клиентов</h2>${cards('review')}
    <details id="other"><summary>Сайты без обнаруженных проблем из проверенного списка (${counts.other})</summary>${cards('other')}</details>
    <footer>Источники исходной базы: © OpenStreetMap contributors, ODbL. Сохраняйте ссылки и проверяйте актуальность сведений.</footer></body></html>`;
}

export function internalTargets(homeUrl, links, excluded = []) {
  const home = new URL(homeUrl), seen = new Set([home.href, ...excluded]); const result = [];
  for (const raw of links) {
    try {
      const u = new URL(raw);
      if (u.origin !== home.origin || u.username || u.password || u.search || u.hash || seen.has(u.href)) continue;
      // Small content-page allowlist, not arbitrary GET actions or a crawler.
      if (!/\/(?:about|services?|uslugi|prices?|ceny|tseny|o-nas|company|portfolio|team|контакты|услуги|цены|о-нас)(?:\/|[._-]|$)/i.test(decodeURIComponent(u.pathname))) continue;
      if (/logout|delete|remove|unsubscribe|submit|send|cart|login|download/i.test(u.pathname) || /\.(pdf|zip|exe|jpe?g|png|svg)$/i.test(u.pathname)) continue;
      seen.add(u.href); result.push(u.href); if (result.length === 2) break;
    } catch { /* malformed links are not navigated */ }
  }
  return result;
}
