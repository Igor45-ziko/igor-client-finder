import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, createAuditor } from '../src/audit/browser.mjs';
import { normalizeElement } from '../src/model.mjs';
import { CITIES } from '../src/config.mjs';
import { temporary, element, timestamp } from './helpers.mjs';
import { runSavedBase } from '../src/audit/saved-base.mjs';

// All pages and contacts below are synthetic. No external websites or messages.
async function fixture(t, { deny = false, pageText = '', overflow = false, posting = false, internal = false } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    received.push({ method: req.method, url: req.url });
    if (req.url === '/robots.txt') { res.end(`User-agent: *\nDisallow: ${deny ? '/' : ''}\n`); return; }
    if (req.url === '/broken.png' || req.url === '/contacts') { res.statusCode = 404; res.end('Not found'); return; }
    if (internal && req.url === '/services') { res.statusCode = 404; res.end('Synthetic missing content page'); return; }
    if (internal && req.url === '/about') { res.statusCode = 403; res.end('Synthetic access restriction'); return; }
    if (req.url === '/submit') { res.end('UNEXPECTED FORM SUBMISSION'); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test only</title>
      <body>${pageText}<a href="/contacts">Контакты</a><img src="/broken.png" width="50" height="50">${overflow ? '<div style="width:1200px;height:50px;background:red">TEST OVERFLOW</div>' : ''}
      ${internal ? '<a href="/services">Услуги</a><a href="/about">О нас</a>' : ''}
      ${posting ? '<script>fetch("/submit",{method:"POST",body:"test"}).catch(()=>{});</script>' : ''}</body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auditor = createAuditor({ browser, guard: async raw => new URL(raw), fetchImpl: fetch, pause: async () => {} });
  const row = normalizeElement(element(1, { name: 'Сигма Мотор ТЕСТ' }), CITIES[0], timestamp);
  return { received, base, auditor, row, browser };
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

test('bounded internal link audit records actual HTTP 404 but never calls a 403 a broken link', async t => {
  const root = await temporary(t); const f = await fixture(t, { pageText: 'Сигма Мотор ТЕСТ Телефон +7 000 000-00-01', internal: true });
  const result = await f.auditor(f.row, { url: f.base, sources: [] }, { outputDir: root, slug: 'links' });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.issues.filter(i => i.code === 'link_404').length, 1);
  assert.equal(result.issues.find(i => i.code === 'link_404').url, f.base + '/services');
  assert.equal(result.linkChecks.length, 2); assert.equal(result.linkChecks[1].status, 'unavailable');
  assert.ok(!result.issues.some(i => i.url === f.base + '/about'));
});

test('saved-base produces a portable shortlist with real Chromium evidence, then resumes without another website request', async t => {
  const root = await temporary(t);
  const f = await fixture(t, { pageText: 'Сигма Мотор ТЕСТ Телефон +7 000 000-00-01', overflow: true, posting: true });
  f.row.rawWebsites = [f.base];
  await mkdir(join(root, 'outputs', 'original'), { recursive: true });
  await writeFile(join(root, 'outputs', 'original', 'organizations.json'), JSON.stringify([f.row]));
  const options = { root, log: () => {}, browserFactory: async () => ({ close: async () => {} }), auditorFactory: () => f.auditor };
  const first = await runSavedBase(options);
  assert.equal(first.shortlist.length, 1); assert.equal(first.report.confirmedSites, 1);
  assert.match(await readFile(join(first.output, 'shortlist.csv'), 'utf8'), /Переполнение на телефоне/);
  const count = f.received.length;
  const second = await runSavedBase({ ...options, browserFactory: () => assert.fail('Cached site must not launch browser') });
  assert.equal(f.received.length, count); assert.equal(second.shortlist.length, 1);
  assert.equal(second.results[0].reused, true);
  for (const name of second.results[0].checks[0].screenshots) assert.ok((await stat(join(second.output, 'screenshots', name))).size > 100);
  assert.equal(second.results[0].checks[0].screenshots.length, 2);
  assert.equal(f.received.some(x => x.method === 'POST'), false);
});

test('site deadline closes a real browser context during a stalled navigation', async t => {
  const root = await temporary(t); const server = createServer((req, res) => {
    if (req.url === '/robots.txt') res.end('User-agent: *\nDisallow:\n');
    // The synthetic homepage deliberately never responds.
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await launchBrowser(); t.after(() => browser.close());
  const audit = createAuditor({ browser, guard: async raw => new URL(raw), pause: async () => {} });
  const result = await audit(normalizeElement(element(), CITIES[0], timestamp),
    { url: `http://127.0.0.1:${server.address().port}`, sources: [] }, { outputDir: root, slug: 'stall', timeoutMs: 1500 });
  assert.equal(result.errorCode, 'SITE_TIMEOUT'); assert.equal(result.failureStage, 'homepage');
  for (let i = 0; i < 30 && browser.contexts().length; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(browser.contexts().length, 0);
});
