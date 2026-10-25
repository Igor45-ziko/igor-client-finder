import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CACHE_MS, MIN_INTERVAL_MS, USER_AGENT } from './config.mjs';

export class SearchError extends Error {
  constructor(code, message, { stop = false } = {}) {
    super(message); this.name = 'SearchError'; this.code = code; this.stop = stop;
  }
}

export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

export function validatePayload(data) {
  if (!data || !Array.isArray(data.elements))
    throw new SearchError('INVALID_RESPONSE', 'Сервер вернул ответ без списка elements.');
  // Overpass may return HTTP 200 with incomplete elements and a runtime-error remark.
  if (data.remark)
    throw new SearchError('OVERPASS_INCOMPLETE', 'Overpass сообщил об ошибке выполнения. Неполные данные не используются.');
  if (data.elements.length > 10000)
    throw new SearchError('TOO_MANY_ELEMENTS', 'Слишком большая выборка; остановка без обрезания данных.');
  if (data.elements.some(x => !x || !['node', 'way', 'relation'].includes(x.type) ||
      !Number.isSafeInteger(x.id) || x.id <= 0 || !x.tags || typeof x.tags !== 'object' || Array.isArray(x.tags)))
    throw new SearchError('INVALID_RESPONSE', 'Некорректный объект в ответе Overpass.');
  return data;
}

async function limitedText(response) {
  const limit = 16 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new SearchError('RESPONSE_TOO_LARGE', 'Ответ превышает ограничение 16 МБ.');
  }
  const chunks = []; let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > limit) throw new SearchError('RESPONSE_TOO_LARGE', 'Ответ превышает ограничение 16 МБ.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function retryAfterMs(value, now) {
  if (value && /^\d+$/.test(value.trim())) return Math.max(60000, Number(value) * 1000);
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? Math.max(60000, timestamp - now) : 30 * 60 * 1000;
}

export function makeClient({ endpoint, cacheDir, fetchImpl = fetch, clock = Date.now,
  sleep = ms => delay(ms), log = () => {}, signal, interval = MIN_INTERVAL_MS }) {
  const statePath = join(cacheDir, 'network-state.json');
  return {
    async search(query, { refresh = false } = {}) {
      await mkdir(cacheDir, { recursive: true });
      const key = createHash('sha256').update(endpoint + '\n' + query).digest('hex');
      const cachePath = join(cacheDir, `${key}.json`);
      const cached = await readJson(cachePath);
      if (!refresh && cached?.endpoint === endpoint && cached?.query === query &&
          Number.isFinite(cached.fetchedAt) && clock() >= cached.fetchedAt && clock() - cached.fetchedAt < CACHE_MS) {
        try {
          validatePayload(cached.data);
          return { data: cached.data, fetchedAt: cached.fetchedAt, fromCache: true };
        } catch { /* A damaged cache is never reported as a successful search. */ }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) throw new SearchError('CANCELLED', 'Поиск остановлен пользователем.', { stop: true });
        const state = (await readJson(statePath)) || {};
        if (Number.isFinite(state.blockedUntil) && state.blockedUntil > clock())
          throw new SearchError('RATE_LIMIT', `Пауза после ограничения сервера до ${new Date(state.blockedUntil).toISOString()}.`, { stop: true });
        const wait = Math.max(0, interval - (clock() - (Number(state.lastRequestAt) || 0)));
        if (wait) { log(`Пауза ${Math.ceil(wait / 1000)} с между запросами.`); await sleep(wait); }
        if (signal?.aborted) throw new SearchError('CANCELLED', 'Поиск остановлен пользователем.', { stop: true });
        await writeJson(statePath, { ...state, lastRequestAt: clock() });
        let response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST', redirect: 'error',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' },
            body: new URLSearchParams({ data: query }),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
          });
        } catch (error) {
          if (signal?.aborted) throw new SearchError('CANCELLED', 'Поиск остановлен пользователем.', { stop: true });
          // Do not print fetch errors: they can contain credential-bearing proxy URLs.
          if (error.name === 'TimeoutError')
            throw new SearchError('TIMEOUT', 'Overpass не ответил за 45 секунд; неполные данные не используются.');
          throw new SearchError('NETWORK', 'Не удалось подключиться к Overpass. Проверьте Интернет, доступ к overpass-api.de и настройки прокси. Ограничения не обходятся.', { stop: true });
        }
        if (response.status === 429) {
          const blockedUntil = clock() + retryAfterMs(response.headers.get('retry-after'), clock());
          await response.body?.cancel();
          await writeJson(statePath, { lastRequestAt: clock(), blockedUntil });
          throw new SearchError('RATE_LIMIT', `Overpass ограничил частоту. Следующий сетевой запрос разрешён не раньше ${new Date(blockedUntil).toISOString()}.`, { stop: true });
        }
        if ([401, 403, 407].includes(response.status)) {
          await response.body?.cancel();
          throw new SearchError('ACCESS_DENIED', `Доступ запрещён (HTTP ${response.status}). Поиск остановлен, другие серверы автоматически не используются.`, { stop: true });
        }
        if ([502, 503, 504].includes(response.status)) {
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter && retryAfterMs(retryAfter, clock()) > 30000) {
            const blockedUntil = clock() + retryAfterMs(retryAfter, clock());
            await response.body?.cancel();
            await writeJson(statePath, { lastRequestAt: clock(), blockedUntil });
            throw new SearchError('SERVICE_COOLDOWN', `Сервер попросил паузу до ${new Date(blockedUntil).toISOString()}. Поиск остановлен.`, { stop: true });
          }
          if (attempt === 0) {
            await response.body?.cancel();
            log('Overpass временно недоступен. Одна повторная попытка через 30 секунд.');
            await sleep(30000); continue;
          }
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new SearchError('HTTP_ERROR', `Ошибка Overpass: HTTP ${response.status}.`, { stop: response.status === 400 });
        }
        let text;
        try { text = await limitedText(response); }
        catch (error) {
          if (error instanceof SearchError) throw error;
          throw new SearchError('READ_FAILED', 'Ответ сервера оборвался; данные этого города не используются.');
        }
        let data;
        try { data = JSON.parse(text); }
        catch { throw new SearchError('INVALID_JSON', 'Вместо JSON сервер вернул другой ответ; данные не используются.'); }
        validatePayload(data);
        const fetchedAt = clock();
        await writeJson(cachePath, { endpoint, query, fetchedAt, data });
        return { data, fetchedAt, fromCache: false };
      }
    },
  };
}
