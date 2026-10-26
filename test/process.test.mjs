import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { runDownload, loadOverture, ensureOverture } from '../src/audit/overture.mjs';
import { terminateTree } from '../src/audit/process.mjs';
import { CITIES } from '../src/config.mjs';
import { temporary, response, timestamp, element } from './helpers.mjs';
import { runAudit } from '../src/audit/run.mjs';
import { normalizeElement } from '../src/model.mjs';

const fixture = new URL('./fixtures/download-tree.mjs', import.meta.url);
function mockChild() {
  const c = new EventEmitter(); c.pid = 12345; c.stdout = new PassThrough(); c.stderr = new PassThrough();
  c.unref = () => {}; c.kill = () => true; return c;
}
async function waitFile(path) {
  for (let i = 0; i < 100; i++) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (text) return text;
    await sleep(30);
  }
  throw new Error('Local fixture failed to start');
}
for (const action of ['deadline', 'abort']) {
  test(`real ${process.platform} process tree is killed on ${action}; worker stops writing`, { timeout: 15000 }, async t => {
    const root = await temporary(t), ready = join(root, 'ready.json'), heartbeat = join(root, 'worker.txt');
    const controller = new AbortController(); const logs = []; let ids;
    t.after(async () => { if (ids) await terminateTree(ids.parent).catch(() => {}); });
    const started = Date.now();
    const promise = runDownload(process.execPath, [fileURLToPath(fixture), 'parent', ready, heartbeat], {
      timeoutMs: 2500, heartbeatMs: 100, signal: controller.signal, log: line => logs.push(line),
    });
    // Attach rejection immediately, including on a slow CI worker.
    const failure = promise.then(() => assert.fail('Expected cancellation'), e => e);
    ids = JSON.parse(await waitFile(ready)); await waitFile(heartbeat);
    if (action === 'abort') controller.abort();
    const error = await failure;
    assert.match(error.message, action === 'abort' ? /пользователем/ : /превысила лимит/);
    assert.equal(error.cleanupFailed, undefined, error.message);
    assert.ok(Date.now() - started < 10000);
    const size = (await stat(heartbeat)).size; const messages = logs.length;
    await sleep(250);
    assert.equal((await stat(heartbeat)).size, size, 'grandchild must stop writing');
    assert.equal(logs.length, messages, 'no heartbeat after settlement');
    assert.ok(logs.some(x => x.includes('Дерево процессов Overture остановлено')));
    if (process.platform === 'win32') {
      for (const pid of Object.values(ids)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  });
}

test('Windows termination uses absolute taskkill, /T /F and only the owned PID', async () => {
  let call; const killer = mockChild();
  await terminateTree(12345, { platform: 'win32', spawnImpl: (...args) => {
    call = args; queueMicrotask(() => killer.emit('exit', 0)); return killer;
  } });
  assert.match(call[0], /System32[\\/]taskkill\.exe$/);
  assert.deepEqual(call[1], ['/PID', '12345', '/T', '/F']); assert.equal(call[2].shell, false);
});
test('taskkill failure or hang is reported within a bounded time', async () => {
  await assert.rejects(terminateTree(12345, { platform: 'win32', spawnImpl: () => {
    const killer = mockChild(); queueMicrotask(() => killer.emit('exit', 5)); return killer;
  } }), /кодом 5/);
  await assert.rejects(terminateTree(12345, { platform: 'win32', timeoutMs: 20, spawnImpl: mockChild }), /не ответил/);
});
test('inherited pipes never closing do not defeat deadline or keep progress alive', async () => {
  const child = mockChild(); const logs = []; let kills = 0;
  await assert.rejects(runDownload('synthetic', [], { timeoutMs: 30, heartbeatMs: 10,
    spawnImpl: () => child, killTree: async pid => { assert.equal(pid, child.pid); kills++; }, log: x => logs.push(x) }), /превысила/);
  assert.equal(kills, 1); assert.equal(child.stdout.destroyed, true);
  const length = logs.length; await sleep(50); assert.equal(logs.length, length);
});
test('unresponsive termination itself has a deadline and flags unconfirmed cleanup', async () => {
  await assert.rejects(runDownload('synthetic', [], { timeoutMs: 15, stopTimeoutMs: 20,
    spawnImpl: mockChild, killTree: () => new Promise(() => {}) }), e => e.cleanupFailed === true && /не подтверждена/.test(e.message));
});
test('already aborted download never spawns a process', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runDownload('synthetic', [], { signal: controller.signal, spawnImpl: () => assert.fail('spawned') }), /не запущен/);
});
test('blocked source is killed without retry; size limit also kills the tree', async t => {
  const child = mockChild(); let kills = 0;
  await assert.rejects(runDownload('synthetic', [], {
    spawnImpl: () => { queueMicrotask(() => child.stderr.write('403 Forbidden')); return child; },
    killTree: async () => { kills++; },
  }), /запретил доступ/);
  const root = await temporary(t), output = join(root, 'partial.json'); await writeFile(output, 'x'.repeat(101));
  await assert.rejects(runDownload('synthetic', [], { output, maxBytes: 100, heartbeatMs: 10,
    spawnImpl: mockChild, killTree: async () => { kills++; } }), /превысила/);
  assert.equal(kills, 2);
});
test('successful exit and spawn failure both clear timers', async () => {
  await runDownload('synthetic', [], { spawnImpl: () => {
    const child = mockChild(); queueMicrotask(() => child.emit('close', 0)); return child;
  } });
  await assert.rejects(runDownload('synthetic', [], { spawnImpl: () => {
    const child = mockChild(); queueMicrotask(() => child.emit('error', Object.assign(new Error(), { code: 'ENOENT' }))); return child;
  } }), /ENOENT/);
});
test('Ctrl+C cancels STAC before an installer or data download can run', async t => {
  const root = await temporary(t); const controller = new AbortController();
  const result = await loadOverture(CITIES[0], { root, env: {}, log: () => {}, signal: controller.signal,
    installer: () => assert.fail('installer ran'), download: () => assert.fail('download ran'),
    fetchImpl: async (url, { signal }) => {
      const pending = new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      controller.abort(); return pending;
    } });
  assert.equal(result.status, 'unavailable'); assert.match(result.message, /отменена/);
});
test('cancelled tool download removes only its own temporary file', async t => {
  const root = await temporary(t); const controller = new AbortController();
  await mkdir(join(root, '.tools')); await writeFile(join(root, '.tools', 'keep.txt'), 'keep');
  await assert.rejects(ensureOverture(root, { signal: controller.signal, log: () => {}, fetchImpl: async () => {
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new Uint8Array([1, 2, 3])); setTimeout(() => controller.abort(), 20);
    } }));
  } }));
  assert.deepEqual(await readdir(join(root, '.tools')), ['keep.txt']);
});
test('failed city download preserves old cache and old outputs, does not cache a partial file', async t => {
  const root = await temporary(t); const dir = join(root, '.cache', 'overture'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'existing.json'), 'old cache');
  const result = await loadOverture(CITIES[0], { root, env: {}, log: () => {}, fetchImpl: async () => response({ latest: '2026-10-15.0' }),
    installer: async () => 'synthetic', download: async (exe, args, { output }) => {
      await writeFile(output, '{partial'); throw new Error('synthetic timeout');
    } });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(await readdir(dir), ['existing.json']); assert.equal(await readFile(join(dir, 'existing.json'), 'utf8'), 'old cache');
});
test('unconfirmed process termination disables later cities and creates partial HTML + diagnostics', async t => {
  const root = await temporary(t); const inputDir = join(root, 'outputs', 'old'); await mkdir(inputDir, { recursive: true });
  const rows = [normalizeElement(element(), CITIES[0], timestamp), normalizeElement(element(2, {}, { lat: CITIES[1].lat, lon: CITIES[1].lon }), CITIES[1], timestamp)];
  const original = JSON.stringify(rows); await writeFile(join(inputDir, 'organizations.json'), original); let calls = 0;
  const result = await runAudit({ root, log: () => {}, provider: async () => {
    calls++; return { status: 'unavailable', cleanupFailed: true, message: 'synthetic cleanup failure' };
  } });
  assert.equal(calls, 1); assert.equal(result.report.status, 'partial'); assert.equal(result.shortlist.length, 0);
  assert.match(await readFile(join(result.output, 'report.html'), 'utf8'), /завершение предыдущего процесса/);
  assert.match(await readFile(join(result.output, 'diagnostics.log'), 'utf8'), /synthetic cleanup failure/);
  assert.equal(await readFile(join(inputDir, 'organizations.json'), 'utf8'), original);
});
test('abort during independent lookup exports interrupted report and never starts next city or browser', async t => {
  const root = await temporary(t); await mkdir(join(root, 'outputs', 'old'), { recursive: true });
  await writeFile(join(root, 'outputs', 'old', 'organizations.json'), JSON.stringify([
    normalizeElement(element(), CITIES[0], timestamp), normalizeElement(element(2, {}, { lat: CITIES[1].lat, lon: CITIES[1].lon }), CITIES[1], timestamp),
  ]));
  const controller = new AbortController(); let calls = 0;
  const result = await runAudit({ root, signal: controller.signal, log: () => {}, browserFactory: () => assert.fail('browser started'),
    provider: async () => { calls++; controller.abort(); return { status: 'unavailable', message: 'cancelled' }; } });
  assert.equal(calls, 1); assert.equal(result.report.status, 'interrupted'); assert.equal(result.report.checked, 2); // Baseline records were checkpointed before optional lookup.
  assert.match(await readFile(join(result.output, 'report.html'), 'utf8'), /interrupted/);
  assert.equal(await stat(join(root, '.cache', 'run.lock')).catch(() => null), null);
});
test('production default deadline is exactly 300 seconds, even without close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let killed = false;
  const result = runDownload('synthetic', [], { spawnImpl: mockChild, killTree: async () => { killed = true; } }).catch(e => e);
  t.mock.timers.tick(299999); await Promise.resolve(); assert.equal(killed, false);
  t.mock.timers.tick(1); const error = await result;
  assert.equal(killed, true); assert.match(error.message, /лимит 300 с/);
});
test('close racing with abort cannot report success or repeat termination', async () => {
  const controller = new AbortController(), child = mockChild(); let calls = 0;
  const result = runDownload('synthetic', [], { signal: controller.signal, spawnImpl: () => child,
    killTree: async () => { calls++; child.emit('close', 0); await sleep(10); } });
  controller.abort(); controller.abort();
  await assert.rejects(result, /пользователем/); assert.equal(calls, 1);
});
