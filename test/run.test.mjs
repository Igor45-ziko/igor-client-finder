import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { run } from '../src/run.mjs';
import { CITIES } from '../src/config.mjs';
import { temporary, timestamp, element, payload, response } from './helpers.mjs';

const common = { clock: () => timestamp, interval: 0, sleep: async () => {}, log: () => {} };
test('end-to-end synthetic search exports CSV, provenance, deduped shortlist and reserves', async t => {
  const root = await temporary(t);
  const records = [element(), element(2), element(3, { name: 'Тест с сайтом', website: 'example.org' }), element(4, { name: 'Без контактов', phone: '' })];
  const result = await run({ ...common, root, cities: [CITIES[0]], fetchImpl: async () => response(payload(records)) });
  assert.equal(result.exitCode, 0); assert.equal(result.report.status, 'complete');
  assert.equal(result.report.rawCount, 4); assert.equal(result.report.duplicatesMerged, 1); assert.equal(result.report.leads, 1);
  const names = await readdir(result.output);
  for (const name of ['leads.csv', 'review.csv', 'all-organizations.csv', 'report.json', 'organizations.json', 'README.txt']) assert.ok(names.includes(name));
  const csv = await readFile(join(result.output, 'leads.csv'), 'utf8');
  assert.equal(csv.charCodeAt(0), 0xfeff); assert.match(csv, /отсутствие сайта не подтверждено/);
  assert.doesNotMatch(csv, /Тест с сайтом/);
  assert.equal(JSON.parse(await readFile(join(result.output, 'organizations.json'), 'utf8'))[0].sources.length, 2);
  assert.equal((await readdir(join(root, '.cache'))).includes('run.lock'), false);
});
test('a fresh run preserves previous results and uses cached data', async t => {
  const root = await temporary(t); let requests = 0;
  const options = { ...common, root, cities: [CITIES[0]], fetchImpl: async () => { requests++; return response(payload()); } };
  const first = await run(options); const second = await run(options);
  assert.notEqual(first.output, second.output); assert.equal(requests, 1);
  assert.equal(second.report.cities[0].fromCache, true);
  assert.ok((await readFile(join(first.output, 'leads.csv'), 'utf8')).length);
});
test('access denial stops other cities and creates an explicitly FAILED report, not a successful empty search', async t => {
  const root = await temporary(t); let requests = 0;
  const result = await run({ ...common, root, fetchImpl: async () => { requests++; return new Response('denied', { status: 403 }); } });
  assert.equal(requests, 1); assert.equal(result.exitCode, 2); assert.equal(result.report.status, 'failed');
  assert.deepEqual(result.report.cities.map(x => x.status), ['error', 'not_requested', 'not_requested']);
  assert.match(await readFile(join(result.output, 'README.txt'), 'utf8'), /Нулевой результат при ошибке не означает/);
});
test('partial success preserves good city results and marks later failure', async t => {
  const root = await temporary(t); let requests = 0;
  const result = await run({ ...common, root, fetchImpl: async () => ++requests === 1 ? response(payload()) : new Response('denied', { status: 403 }) });
  assert.equal(result.exitCode, 2); assert.equal(result.report.status, 'partial'); assert.equal(result.report.leads, 1);
});
test('valid zero-result response is COMPLETE and distinguished from a failure', async t => {
  const root = await temporary(t);
  const result = await run({ ...common, root, cities: [CITIES[0]], fetchImpl: async () => response(payload([])) });
  assert.equal(result.exitCode, 0); assert.equal(result.report.status, 'complete'); assert.equal(result.report.leads, 0);
});
test('all three cities are searched, while the final shortlist is capped', async t => {
  const root = await temporary(t); let requests = 0;
  const result = await run({ ...common, root, target: 1, fetchImpl: async () => {
    const city = CITIES[requests++];
    return response(payload([element(requests, { name: `Тестовый объект ${requests}` }, { lat: city.lat, lon: city.lon })]));
  } });
  assert.equal(requests, 3); assert.equal(result.report.organizations, 3); assert.equal(result.report.leads, 1); assert.equal(result.report.totalEligible, 3);
});
test('concurrent process lock prevents any network request', async t => {
  const root = await temporary(t); await mkdir(join(root, '.cache'));
  await writeFile(join(root, '.cache', 'run.lock'), JSON.stringify({ pid: process.pid }));
  let called = false;
  await assert.rejects(run({ ...common, root, fetchImpl: async () => { called = true; } }), e => e.code === 'LOCKED');
  assert.equal(called, false);
});
test('CLI help works from another directory, invalid args have nonzero exit status', () => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /npm\.cmd start/);
  const invalid = spawnSync(process.execPath, [cli, '--target', '500'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
});
