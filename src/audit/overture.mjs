import { mkdir, readFile, stat, chmod, rename, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readJson, writeJson } from '../network.mjs';

export const CATALOG = 'https://stac.overturemaps.org/catalog.json';
export const OVERTURE_ATTRIBUTION = 'Overture Maps Foundation / Places; retain per-record sources. Licenses: https://docs.overturemaps.org/attribution/';
const VERSION = '1.0.2';
export const BINARIES = {
  'win32-x64': { name: `overturemaps-${VERSION}-windows-x86_64.exe`, sha256: '6ab83c9e29a865ba7a2cd7094110ebc4cc0d5b5bd0a63cb0afc046783c750e81' },
  'linux-x64': { name: `overturemaps-${VERSION}-linux-x86_64`, sha256: 'e398ff026dbf5ddb4fd909547f7bd39b8a85a88d213d982dcae81e302059f3c4' },
};

export function bboxFor(city) {
  const y = city.radius / 111320;
  const x = y / Math.cos(city.lat * Math.PI / 180);
  return [city.lon - x, city.lat - y, city.lon + x, city.lat + y].map(n => Number(n.toFixed(6)));
}

export function validatePlaces(data) {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.features.length > 100000)
    throw new Error('Некорректная или слишком большая выгрузка Overture.');
  for (const feature of data.features) {
    if (feature?.type !== 'Feature' || feature.geometry?.type !== 'Point' ||
        !feature.geometry.coordinates?.slice(0, 2).every(Number.isFinite) || feature.geometry.coordinates.length < 2 ||
        !feature.properties || typeof feature.properties !== 'object') throw new Error('Неожиданный формат объекта Overture.');
  }
  return data;
}

export async function ensureOverture(root, { fetchImpl = fetch, log = console.log } = {}) {
  const spec = BINARIES[`${process.platform}-${process.arch}`];
  if (!spec) throw new Error('Автоматическая установка Overture доступна для Windows x64 и Linux x64.');
  const dir = join(root, '.tools'); await mkdir(dir, { recursive: true });
  const path = join(dir, spec.name);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    if (digest(await readFile(path)) !== spec.sha256) throw new Error('Контрольная сумма загрузчика Overture не совпадает. Файл не запущен.');
    return path;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  log('Установка официального Overture CLI 1.0.2 (Windows ≈56 МБ, Linux ≈80 МБ); Python устанавливать не нужно.');
  const url = `https://github.com/OvertureMaps/overturemaps-py/releases/download/v${VERSION}/${spec.name}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(240000) });
  if (!response.ok) throw new Error(`Загрузка Overture запрещена или недоступна: HTTP ${response.status}.`);
  const temp = path + '.' + randomUUID() + '.tmp';
  let bytes = 0; const hash = createHash('sha256');
  const guard = new Transform({ transform(chunk, encoding, next) {
    bytes += chunk.length;
    if (bytes > 150 * 1024 * 1024) return next(new Error('Загрузчик превышает допустимый размер.'));
    hash.update(chunk); next(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(temp, { flags: 'wx' }));
    if (hash.digest('hex') !== spec.sha256) throw new Error('SHA-256 Overture не совпадает: исполнение запрещено.');
    await chmod(temp, 0o700); await rename(temp, path); return path;
  } finally { await unlink(temp).catch(() => {}); }
}

export function runDownload(executable, args, { signal, log = () => {}, output } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let error = '', stopped = '';
    const stop = reason => { stopped ||= reason; child.kill(); };
    const timer = setTimeout(() => stop('Выгрузка Overture превысила 5 минут; частичный файл не используется.'), 300000);
    const heartbeat = setInterval(() => log('Overture: продолжается выборка небольшого района…'), 20000);
    const monitor = setInterval(async () => {
      if (output && (await stat(output).catch(() => null))?.size > 100 * 1024 * 1024)
        stop('Выгрузка превысила 100 МБ; остановлено.');
    }, 1000);
    const abort = () => stop('Выгрузка остановлена пользователем.');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const consume = chunk => {
      const text = String(chunk); error = (error + text).slice(-5000);
      if (/Error reading STAC index|AccessDenied|403 Forbidden|Too Many Requests/i.test(text))
        stop('Каталог Overture недоступен или запретил доступ; переход к другой схеме загрузки отключён.');
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    const cleanup = () => { clearTimeout(timer); clearInterval(heartbeat); clearInterval(monitor); signal?.removeEventListener('abort', abort); };
    child.on('error', e => { cleanup(); reject(new Error(`Не удалось запустить Overture (${e.code || 'ошибка процесса'}).`)); });
    child.on('close', code => {
      cleanup();
      if (stopped || code !== 0 || /Error reading dataset|Traceback/i.test(error)) reject(new Error(stopped || `Overture не завершил выгрузку, код ${code}.`));
      else resolve();
    });
  });
}

export async function loadOverture(city, { root, fetchImpl = fetch, clock = Date.now, log = console.log, signal,
  download = runDownload, installer = ensureOverture, env = process.env } = {}) {
  const bbox = bboxFor(city);
  const dir = join(root, '.cache', 'overture'); await mkdir(dir, { recursive: true });
  const key = createHash('sha256').update(JSON.stringify(bbox)).digest('hex').slice(0, 20);
  const path = join(dir, `${key}.json`); const cache = await readJson(path);
  if (cache?.fetchedAt && clock() >= cache.fetchedAt && clock() - cache.fetchedAt < 7 * 86400000) {
    try { validatePlaces(cache.data); return { ...cache, status: 'ok', fromCache: true }; } catch { /* ignore damaged cache */ }
  }
  // PyArrow S3 in the official executable does not expose proxy_options. Never unset
  // proxy variables or launch a potentially direct S3 path in a managed proxy environment.
  if (['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'].some(k => env[k]))
    return { status: 'unavailable', message: 'В среде задан прокси. Официальный Overture CLI не гарантирует его использование для S3; прямое соединение не запускалось. Нужна поддерживаемая конфигурация доступа.', features: [] };
  let temp;
  try {
    const response = await fetchImpl(CATALOG, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'IgorClientFinder/0.2' } });
    if (!response.ok) throw new Error(`Каталог Overture: HTTP ${response.status}.`);
    const text = await response.text(); if (text.length > 5000000) throw new Error('Слишком большой STAC каталог.');
    const catalog = JSON.parse(text); const release = catalog.latest;
    if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release || '')) throw new Error('Не удалось определить актуальный выпуск Overture.');
    const executable = await installer(root, { fetchImpl, log });
    temp = join(dir, `${key}-${randomUUID()}.geojson`);
    log(`${city.name}: независимый поиск в Overture ${release}…`);
    await download(executable, ['download', `--bbox=${bbox.join(',')}`, '--type=place', '--release', release,
      '-f', 'geojson', '--stac', '--connect_timeout', '15', '--request_timeout', '30', '-o', temp], { signal, log, output: temp });
    const info = await stat(temp); if (info.size > 100 * 1024 * 1024) throw new Error('Выгрузка слишком велика.');
    const data = validatePlaces(JSON.parse(await readFile(temp, 'utf8')));
    const result = { fetchedAt: clock(), release, bbox, data, sourceUrl: `https://stac.overturemaps.org/${release}/catalog.json`, attribution: OVERTURE_ATTRIBUTION };
    await writeJson(path, result); return { ...result, status: 'ok', fromCache: false };
  } catch (error) {
    return { status: 'unavailable', message: error instanceof SyntaxError ? 'Некорректный ответ Overture.' :
      (/fetch failed|network|TLS|certificate/i.test(error.message) ? 'Сетевой доступ к Overture не подтверждён.' : error.message), features: [] };
  } finally { if (temp) await unlink(temp).catch(() => {}); }
}
