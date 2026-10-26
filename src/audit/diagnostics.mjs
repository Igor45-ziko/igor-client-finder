import { performance } from 'node:perf_hooks';

export const ATP_MANIFEST = 'https://alltheplaces-data.openaddresses.io/runs/latest.json';
export const WIKIDATA_RECORD = 'https://www.wikidata.org/wiki/Special:EntityData/Q129632037.json';
const STAC = 'https://stac.overturemaps.org/catalog.json';

// Small read-only probes, no native downloader, no redirects to unreviewed hosts,
// no alternate mirrors, no company/contact submissions and no proxy manipulation.
export async function probe(url, { fetchImpl = fetch, signal, timeoutMs = 8000, limit = 262144, prefixOnly = false } = {}) {
  const started = performance.now(); const timed = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timed]) : timed;
  let response;
  try {
    requestSignal.throwIfAborted();
    response = await fetchImpl(url, { redirect: 'manual', signal: requestSignal,
      headers: { 'User-Agent': 'IgorClientFinder/0.2.2 (read-only source diagnostics)', ...(prefixOnly ? { Range: `bytes=0-${limit - 1}` } : {}) } });
    const base = { url, http: response.status, elapsedMs: Math.round(performance.now() - started),
      contentLength: response.headers.get('content-length'), contentType: response.headers.get('content-type'),
      retryAfter: response.headers.get('retry-after') };
    if (!response.ok) { await response.body?.cancel(); return { ...base, status: 'unavailable', code: `HTTP_${response.status}` }; }
    const reader = response.body.getReader(); const parts = []; let bytes = 0;
    try {
      while (true) {
        requestSignal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
        bytes += value.length;
        if (!prefixOnly && bytes > limit) throw new Error('RESPONSE_TOO_LARGE');
        const room = Math.max(0, limit - parts.reduce((n, p) => n + p.length, 0));
        parts.push(value.subarray(0, room));
        if (prefixOnly && bytes >= limit) break;
      }
    } finally { await reader.cancel().catch(() => {}); }
    const data = Buffer.concat(parts.map(x => Buffer.from(x)));
    return { ...base, status: 'reachable', bytes: data.length, prefixOnly, body: data.toString('utf8'), elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { url, status: 'unavailable', http: response?.status, elapsedMs: Math.round(performance.now() - started),
      code: requestSignal.aborted ? (signal?.aborted ? 'CANCELLED_OR_TOTAL_BUDGET' : 'TIMEOUT') :
        error.message === 'RESPONSE_TOO_LARGE' ? error.message : error.cause?.code || error.code || 'NETWORK_OR_PROXY',
      // No full environment or proxy URLs/passwords in diagnostics.
      message: 'Данные не получены. Возможны сеть, прокси, TLS или ограничение источника; это не отсутствие компаний.' };
  }
}
const publicResult = ({ body, ...rest }) => rest;
export async function diagnoseSources({ fetchImpl = fetch, signal, timeoutMs = 8000, totalMs = 45000, log = console.log } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), totalMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const report = { version: '0.2.2', startedAt: new Date().toISOString(), checks: [],
    scope: 'Small connectivity probes only; not a successful website search or proof of source coverage.' };
  const check = async (name, url, options = {}) => {
    log(`${name}: проверка до ${timeoutMs / 1000} с…`);
    const result = await probe(url, { fetchImpl, signal: combined, timeoutMs, ...options });
    report.checks.push({ name, ...publicResult(result) }); log(`  ${result.status}, ${result.http || result.code}, ${result.elapsedMs} мс`);
    return result;
  };
  try {
    const catalog = await check('Overture: каталог', STAC);
    let release;
    if (catalog.status === 'reachable') { try { release = JSON.parse(catalog.body).latest; } catch {} }
    if (/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release || '') && !combined.aborted) {
      const index = await check('Overture: первые 4 КБ индекса (не весь файл)', `https://stac.overturemaps.org/${release}/collections.parquet`, { prefixOnly: true, limit: 4096 });
      report.checks.at(-1).parquetSignature = index.body?.startsWith('PAR1') || false;
      const prefix = encodeURIComponent(`release/${release}/theme=places/type=place/`);
      const s3 = await check('Overture: один ключ публичного S3 (без выгрузки)', `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/?list-type=2&max-keys=1&prefix=${prefix}`);
      report.checks.at(-1).objectListed = s3.status === 'reachable' && /<Key>[^<]+<\/Key>/.test(s3.body);
    } else report.checks.push({ name: 'Overture: индекс и S3', status: 'skipped', code: 'NO_VALID_RELEASE', message: 'Каталог не проверен; последующие запросы Overture не выполнялись.' });
    if (!combined.aborted) {
      const wd = await check('Wikidata: опубликованная запись бренда FIT SERVICE', WIKIDATA_RECORD);
      if (wd.status === 'reachable') {
        try {
          const entity = JSON.parse(wd.body).entities?.Q129632037;
          report.checks.at(-1).entityFound = entity?.id === 'Q129632037';
          report.checks.at(-1).publishedWebsites = (entity?.claims?.P856 || []).map(x => x.mainsnak?.datavalue?.value).filter(x => typeof x === 'string' && /^https?:\/\//.test(x));
        } catch { report.checks.at(-1).parseError = 'Ответ не является ожидаемым JSON.'; }
      }
    }
    if (!combined.aborted) {
      const atp = await check('AllThePlaces: описание последней публикации', ATP_MANIFEST, { limit: 1048576 });
      if (atp.status === 'reachable') {
        try {
          const manifest = JSON.parse(atp.body);
          report.checks.at(-1).manifestKeys = Object.keys(manifest).slice(0, 15);
          report.checks.at(-1).manifestValid = Number.isInteger(manifest.spiders) && Array.isArray(manifest.groups);
          report.checks.at(-1).note = 'Получение описания публикации не подтверждает наличие компаний или сайтов в данных.';
        } catch { report.checks.at(-1).parseError = 'Ответ не является ожидаемым JSON.'; }
      }
    }
    report.status = combined.aborted ? 'interrupted' : report.checks.some(x => x.status !== 'reachable' || x.parseError ||
      ['parquetSignature', 'objectListed', 'entityFound', 'manifestValid'].some(k => x[k] === false)) ? 'partial' : 'complete';
    report.finishedAt = new Date().toISOString(); return report;
  } finally { clearTimeout(timer); }
}
