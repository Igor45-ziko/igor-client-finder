import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, createAuditor } from '../src/audit/browser.mjs';
import { normalizeElement } from '../src/model.mjs';
import { CITIES } from '../src/config.mjs';
import { temporary, element, timestamp } from './helpers.mjs';

// All pages and contacts below are synthetic. No external websites or messages.
async function fixture(t, { deny = false, pageText = '', overflow = false, posting = false } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    received.push({ method: req.method, url: req.url });
    if (req.url === '/robots.txt') { res.end(`User-agent: *\nDisallow: ${deny ? '/' : ''}\n`); return; }
    if (req.url === '/broken.png' || req.url === '/contacts') { res.statusCode = 404; res.end('Not found'); return; }
    if (req.url === '/submit') { res.end('UNEXPECTED FORM SUBMISSION'); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test only</title>
      <body>${pageText}<a href="/contacts">Контакты</a><img src="/broken.png" width="50" height="50">${overflow ? '<div style="width:1200px;height:50px;background:red">TEST OVERFLOW</div>' : ''}
      ${posting ? '<script>fetch("/submit",{method:"POST",body:"test"}).catch(()=>{});</script>' : ''}</body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auditor = createAuditor({ browser, guard: async raw => new URL(raw), fetchImpl: fetch, pause: async () => {} });
  const row = normalizeElement(element(1, { name: 'Сигма Мотор ТЕСТ' }), CITIES[0], timestamp);
  return { received, base, auditor, row };
}

test('Playwright confirms identity, records mobile overflow, HTTP 404 evidence and screenshots without POST', async t => {
  const root = await temporary(t);
  const f = await fixture(t, { pageText: 'Сигма Мотор ТЕСТ Телефон +7 000 000-00-01', overflow: true, posting: true });
  const result = await f.auditor(f.row, { url: f.base, sources: [] }, { outputDir: root, slug: 'test' });
  assert.equal(result.status, 'confirmed'); assert.ok(result.matched.includes('телефон'));
  assert.ok(result.issues.some(x => x.code === 'overflow'));
  assert.ok(result.issues.some(x => x.code === 'contact_404'));
  assert.ok(result.issues.some(x => x.code === 'image_404'));
  assert.equal(f.received.some(x => x.method === 'POST' || x.url === '/submit'), false);
  assert.equal(result.screenshots.length, 2);
  for (const path of result.screenshots) assert.ok((await stat(join(root, path))).size > 100);
});
test('robots denial prevents loading the homepage', async t => {
  const root = await temporary(t); const f = await fixture(t, { deny: true });
  const result = await f.auditor(f.row, { url: f.base, sources: [] }, { outputDir: root, slug: 'denied' });
  assert.equal(result.status, 'access_limited');
  assert.deepEqual(f.received, [{ method: 'GET', url: '/robots.txt' }]);
});
test('lookalike website with different contacts stays unverified even if it has visual problems', async t => {
  const root = await temporary(t); const f = await fixture(t, { pageText: 'Сигма Мотор ТЕСТ Телефон +7 000 000-00-99', overflow: true });
  const result = await f.auditor(f.row, { url: f.base, sources: [] }, { outputDir: root, slug: 'wrong' });
  assert.equal(result.status, 'unverified');
});
