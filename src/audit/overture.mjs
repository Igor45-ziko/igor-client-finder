import { mkdir, readFile, stat, chmod, rename, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { terminateTree } from './process.mjs';
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

export async function ensureOverture(root, { fetchImpl = fetch, log = console.log, signal } = {}) {
  signal?.throwIfAborted();
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
  const requestSignal = combinedSignal(signal, 240000);
  const response = await fetchImpl(url, { signal: requestSignal });
  if (!response.ok) throw new Error(`Загрузка Overture запрещена или недоступна: HTTP ${response.status}.`);
  const temp = path + '.' + randomUUID() + '.tmp';
  let bytes = 0, lastProgress = 0; const hash = createHash('sha256');
  const guard = new Transform({ transform(chunk, encoding, next) {
    bytes += chunk.length;
    if (performance.now() - lastProgress > 5000) {
      lastProgress = performance.now(); log(`Загрузчик Overture: получено ${(bytes / 1048576).toFixed(1)} МБ; лимит установки 240 с.`);
    }
    if (bytes > 150 * 1024 * 1024) return next(new Error('Загрузчик превышает допустимый размер.'));
    hash.update(chunk); next(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(temp, { flags: 'wx' }), { signal: requestSignal });
    if (hash.digest('hex') !== spec.sha256) throw new Error('SHA-256 Overture не совпадает: исполнение запрещено.');
    signal?.throwIfAborted();
    await chmod(temp, 0o700); await rename(temp, path); return path;
  } finally { await unlink(temp).catch(() => {}); }
}

export function runDownload(executable, args, { signal, log = () => {}, output,
  timeoutMs = 300000, heartbeatMs = 20000, stopTimeoutMs = 6000, maxBytes = 100 * 1024 * 1024,
  spawnImpl = spawn, killTree = terminateTree } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('Выгрузка остановлена пользователем; процесс не запущен.'));
  return new Promise((resolve, reject) => {
    // Own process group: console Ctrl+C reaches Node, which kills the COMPLETE tree.
    // It must not kill the PyInstaller bootloader before taskkill can find its worker.
    const child = spawnImpl(executable, args, { detached: true, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    const started = performance.now();
    let error = '', stopped = '', settled = false, bytes = 0, lastOutput = started;
    let stoppingTimer, monitoring = false;
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(stoppingTimer); clearInterval(heartbeat); clearInterval(monitor);
      signal?.removeEventListener('abort', abort);
    };
    const finish = failure => {
      if (settled) return; settled = true; cleanup();
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      if (failure) reject(failure); else resolve();
    };
    const failedStop = detail => {
      const failure = new Error(`${stopped} Остановка дерева PID ${child.pid} не подтверждена: ${detail}. Проверьте этот PID в Диспетчере задач. Новые загрузки Overture в этом запуске отключены.`);
      failure.cleanupFailed = true; log(failure.message); finish(failure);
    };
    const stop = reason => {
      if (settled || stopped) return;
      stopped = reason; clearTimeout(timer); clearInterval(heartbeat); clearInterval(monitor);
      log(`${reason} Завершаем дерево процессов PID ${child.pid} (не более ${stopTimeoutMs / 1000} с)…`);
      if (error.trim()) log(`Последний вывод CLI перед остановкой: ${error.trim().slice(-1000)}`);
      // Settlement does not depend on 'close': orphaned workers can retain pipe handles.
      stoppingTimer = setTimeout(() => failedStop('истёк срок ожидания'), stopTimeoutMs);
      Promise.resolve().then(() => killTree(child.pid)).then(() => {
        if (settled) return;
        log('Дерево процессов Overture остановлено. Частичная выгрузка не используется.');
        finish(new Error(stopped));
      }, e => { if (!settled) failedStop(e.message); });
    };
    const timer = setTimeout(() => stop(`Выгрузка Overture превысила лимит ${Math.round(timeoutMs / 1000)} с.`), timeoutMs);
    const heartbeat = setInterval(() => {
      const elapsed = Math.floor((performance.now() - started) / 1000);
      const quiet = Math.floor((performance.now() - lastOutput) / 1000);
      log(`Overture PID ${child.pid}: прошло ${elapsed} с; до остановки ${Math.max(0, Math.ceil(timeoutMs / 1000) - elapsed)} с; GeoJSON ${(bytes / 1048576).toFixed(2)} МБ. Вывод CLI отсутствует ${quiet} с.`);
      if (error.trim()) log(`Последнее сообщение CLI: ${error.trim().split(/[\r\n]+/).at(-1).slice(0, 300)}`);
      else log('CLI не сообщает прогресс. Нулевой GeoJSON возможен при чтении индексов; это не подтверждение загрузки. Процент и объём сетевого трафика неизвестны.');
    }, heartbeatMs);
    const monitor = setInterval(async () => {
      if (monitoring || stopped || settled) return; monitoring = true;
      try {
        const info = output && await stat(output).catch(() => null);
        if (stopped || settled) return;
        bytes = info?.size || 0;
        if (bytes > maxBytes) stop(`Выгрузка превысила ${(maxBytes / 1048576).toFixed(2)} МБ.`);
      } finally { monitoring = false; }
    }, Math.min(1000, heartbeatMs));
    const abort = () => stop(signal?.reason?.name === 'AbortError' ? 'Выгрузка остановлена пользователем (Ctrl+C).' :
      'Выгрузка остановлена по общему ограничению времени дополнительного источника.');
    signal?.addEventListener('abort', abort, { once: true });
    const consume = chunk => {
      if (settled || stopped) return;
      const text = String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      error = (error + text).slice(-5000); lastOutput = performance.now();
      if (/Error reading STAC index|AccessDenied|403 Forbidden|Too Many Requests/i.test(error))
        stop('Каталог Overture недоступен или запретил доступ; переход к другой схеме загрузки отключён.');
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', e => { if (!stopped) finish(new Error(`Не удалось запустить Overture (${e.code || 'ошибка процесса'}).`)); });
    child.once('close', code => {
      if (stopped) return; // taskkill/group termination owns completion now.
      if (code !== 0 || /Error reading dataset|Traceback/i.test(error))
        finish(new Error(`Overture не завершил выгрузку, код ${code}. ${error.trim().slice(-1000)}`));
      else { log('Overture: процесс завершён; проверяем целостность GeoJSON.'); finish(); }
    });
    log(`Overture: PID ${child.pid}; жёсткий лимит ${timeoutMs / 1000} с + до ${stopTimeoutMs / 1000} с на остановку. Ctrl+C — отмена.`);
    if (signal?.aborted) abort();
  });
}

const combinedSignal = (signal, ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

export async function loadOverture(city, { root, fetchImpl = fetch, clock = Date.now, log = console.log, signal,
  download = runDownload, installer = ensureOverture, env = process.env, mode = 'online', downloadTimeoutMs = 60000 } = {}) {
  if (signal?.aborted) return { status: 'unavailable', message: 'Отменено пользователем.', features: [] };
  const bbox = bboxFor(city);
  const dir = join(root, '.cache', 'overture'); await mkdir(dir, { recursive: true });
  const key = createHash('sha256').update(JSON.stringify(bbox)).digest('hex').slice(0, 20);
  const path = join(dir, `${key}.json`); const cache = await readJson(path);
  if (cache?.fetchedAt && clock() >= cache.fetchedAt && clock() - cache.fetchedAt < 7 * 86400000) {
    try {
      validatePlaces(cache.data); log(`${city.name}: используется сохранённый кэш Overture от ${new Date(cache.fetchedAt).toISOString()}.`);
      return { ...cache, status: 'ok', fromCache: true };
    } catch { /* ignore damaged cache */ }
  }
  if (mode !== 'online') return { status: 'skipped', message: 'Свежего кэша Overture нет. Сетевая выгрузка по умолчанию отключена; независимый поиск не выполнен.', features: [] };
  // PyArrow S3 in the official executable does not expose proxy_options. Never unset
  // proxy variables or launch a potentially direct S3 path in a managed proxy environment.
  if (['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'].some(k => env[k]))
    return { status: 'unavailable', message: 'В среде задан прокси. Официальный Overture CLI не гарантирует его использование для S3; прямое соединение не запускалось. Нужна поддерживаемая конфигурация доступа.', features: [] };
  let temp;
  try {
    signal?.throwIfAborted();
    log(`${city.name}: чтение каталога Overture (лимит 30 с)…`);
    const response = await fetchImpl(CATALOG, { signal: combinedSignal(signal, 30000), headers: { 'User-Agent': 'IgorClientFinder/0.2' } });
    if (!response.ok) throw new Error(`Каталог Overture: HTTP ${response.status}.`);
    const text = await response.text(); if (text.length > 5000000) throw new Error('Слишком большой STAC каталог.');
    const catalog = JSON.parse(text); const release = catalog.latest;
    if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release || '')) throw new Error('Не удалось определить актуальный выпуск Overture.');
    const executable = await installer(root, { fetchImpl, log, signal });
    signal?.throwIfAborted();
    temp = join(dir, `${key}-${randomUUID()}.geojson`);
    log(`${city.name}: независимый поиск в Overture ${release}…`);
    await download(executable, ['download', `--bbox=${bbox.join(',')}`, '--type=place', '--release', release,
      '-f', 'geojson', '--stac', '--connect_timeout', '15', '--request_timeout', '30', '-o', temp], { signal, log, output: temp, timeoutMs: downloadTimeoutMs });
    signal?.throwIfAborted();
    const info = await stat(temp); if (info.size > 100 * 1024 * 1024) throw new Error('Выгрузка слишком велика.');
    const data = validatePlaces(JSON.parse(await readFile(temp, 'utf8')));
    const result = { fetchedAt: clock(), release, bbox, data, sourceUrl: `https://stac.overturemaps.org/${release}/catalog.json`, attribution: OVERTURE_ATTRIBUTION };
    await writeJson(path, result); return { ...result, status: 'ok', fromCache: false };
  } catch (error) {
    return { status: 'unavailable', cleanupFailed: !!error.cleanupFailed, message: error.cleanupFailed ? error.message : signal?.aborted ? 'Дополнительная загрузка отменена пользователем или по общему лимиту времени.' : error instanceof SyntaxError ? 'Некорректный ответ Overture.' :
      (/fetch failed|network|TLS|certificate/i.test(error.message) ? 'Сетевой доступ к Overture не подтверждён.' : error.message), features: [] };
  } finally { if (temp) await unlink(temp).catch(() => {}); }
}
