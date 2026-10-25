import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { makeClient, validatePayload, retryAfterMs } from '../src/network.mjs';
import { CACHE_MS } from '../src/config.mjs';
import { temporary, timestamp, payload, response } from './helpers.mjs';

async function client(t, fetchImpl, options = {}) {
  const root = await temporary(t);
  let now = timestamp;
  const waits = [];
  const c = makeClient({ cacheDir: root, endpoint: 'https://example.invalid/api/interpreter',
    fetchImpl, clock: () => now, sleep: async ms => { waits.push(ms); now += ms; }, ...options });
  return { c, root, waits, advance: ms => { now += ms; } };
}

test('valid cache avoids duplicate requests and preserves retrieval date', async t => {
  let requests = 0;
  const { c } = await client(t, async () => { requests++; return response(payload()); });
  const first = await c.search('query'); const second = await c.search('query');
  assert.equal(requests, 1);
  assert.equal(first.fromCache, false); assert.equal(second.fromCache, true);
  assert.equal(first.fetchedAt, second.fetchedAt);
});
test('expired cache and refresh perform new requests while preserving rate interval', async t => {
  let requests = 0;
  const { c, waits, advance } = await client(t, async () => { requests++; return response(payload()); });
  await c.search('query'); await c.search('query', { refresh: true });
  assert.deepEqual(waits, [15000]);
  advance(CACHE_MS + 1); await c.search('query');
  assert.equal(requests, 3);
});
test('corrupt cached JSON is safely fetched again', async t => {
  let requests = 0;
  const { c, root } = await client(t, async () => { requests++; return response(payload()); });
  await c.search('query');
  const name = (await readdir(root)).find(x => /^[a-f0-9]{64}\.json$/.test(x));
  await writeFile(join(root, name), '{broken');
  await c.search('query'); assert.equal(requests, 2);
});
test('HTTP 403 stops immediately, without retries', async t => {
  let requests = 0;
  const { c } = await client(t, async () => { requests++; return new Response('denied', { status: 403 }); });
  await assert.rejects(c.search('query'), e => e.code === 'ACCESS_DENIED' && e.stop);
  assert.equal(requests, 1);
});
test('HTTP 429 persists cooldown; refresh and a new client cannot bypass it', async t => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response('limited', { status: 429, headers: { 'retry-after': '120' } }); };
  const { c, root } = await client(t, fetchImpl);
  await assert.rejects(c.search('query'), e => e.code === 'RATE_LIMIT');
  const next = makeClient({ cacheDir: root, endpoint: 'https://example.invalid/api/interpreter', fetchImpl, clock: () => timestamp });
  await assert.rejects(next.search('other', { refresh: true }), e => e.code === 'RATE_LIMIT');
  assert.equal(requests, 1);
});
test('Retry-After supports seconds, HTTP dates and conservative default', () => {
  assert.equal(retryAfterMs('120', timestamp), 120000);
  assert.equal(retryAfterMs(new Date(timestamp + 300000).toUTCString(), timestamp), 300000);
  assert.equal(retryAfterMs(null, timestamp), 1800000);
});
test('temporary 503 is retried once after a pause', async t => {
  let requests = 0;
  const { c, waits } = await client(t, async () => ++requests === 1 ? new Response('busy', { status: 503 }) : response(payload()));
  await c.search('query');
  assert.equal(requests, 2); assert.ok(waits.includes(30000));
});
test('persistent 504 has exactly two attempts', async t => {
  let requests = 0;
  const { c } = await client(t, async () => { requests++; return new Response('busy', { status: 504 }); });
  await assert.rejects(c.search('query'), e => e.code === 'HTTP_ERROR');
  assert.equal(requests, 2);
});
test('503 Retry-After is respected without an early retry', async t => {
  let requests = 0;
  const { c } = await client(t, async () => { requests++; return new Response('busy', { status: 503, headers: { 'retry-after': '3600' } }); });
  await assert.rejects(c.search('query'), e => e.code === 'SERVICE_COOLDOWN' && e.stop);
  await assert.rejects(c.search('next'), e => e.code === 'RATE_LIMIT');
  assert.equal(requests, 1);
});
test('Retry-After on the second attempt also stops subsequent city requests', async t => {
  let requests = 0;
  const { c } = await client(t, async () => ++requests === 1 ? new Response('busy', { status: 503 }) :
    new Response('busy', { status: 503, headers: { 'retry-after': '3600' } }));
  await assert.rejects(c.search('query'), e => e.code === 'SERVICE_COOLDOWN');
  await assert.rejects(c.search('other'), e => e.code === 'RATE_LIMIT');
  assert.equal(requests, 2);
});
test('Overpass HTTP 200 runtime remarks and invalid schema never enter cache', async t => {
  const { c, root } = await client(t, async () => response({ ...payload(), remark: 'runtime error: timeout' }));
  await assert.rejects(c.search('query'), e => e.code === 'OVERPASS_INCOMPLETE');
  assert.equal((await readdir(root)).some(x => /^[a-f0-9]{64}\.json$/.test(x)), false);
  assert.throws(() => validatePayload({ elements: [{}] }));
});
test('HTML response and excessive content size are rejected', async t => {
  const a = await client(t, async () => new Response('<html>blocked</html>'));
  await assert.rejects(a.c.search('query'), e => e.code === 'INVALID_JSON');
  const b = await client(t, async () => new Response('large', { headers: { 'content-length': '20000000' } }));
  await assert.rejects(b.c.search('query'), e => e.code === 'RESPONSE_TOO_LARGE');
});
test('network/proxy exceptions stop without leaking their credential-bearing message', async t => {
  const { c } = await client(t, async () => { throw new Error('https://secret:password@proxy.test'); });
  await assert.rejects(c.search('query'), e => e.code === 'NETWORK' && e.stop && !e.message.includes('password'));
});
test('pre-aborted search sends no request', async t => {
  const controller = new AbortController(); controller.abort();
  let called = false;
  const { c } = await client(t, async () => { called = true; }, { signal: controller.signal });
  await assert.rejects(c.search('query'), e => e.code === 'CANCELLED');
  assert.equal(called, false);
});
test('real local HTTP exchange sends one encoded read-only Overpass query with identification', async t => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ method: req.method, body, ua: req.headers['user-agent'] });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { c } = await client(t, fetch, { endpoint: `http://127.0.0.1:${server.address().port}/api/interpreter` });
  await c.search('[out:json];nwr["shop"="car_repair"];out tags;');
  assert.equal(received[0].method, 'POST');
  assert.equal(new URLSearchParams(received[0].body).get('data'), '[out:json];nwr["shop"="car_repair"];out tags;');
  assert.match(received[0].ua, /IgorClientFinder/);
});
