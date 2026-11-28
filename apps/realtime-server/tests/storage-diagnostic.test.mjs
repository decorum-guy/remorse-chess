/** Harness safety/parsing tests; no throughput or browser acceptance claim. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { connect } from 'node:net';
import { test } from 'node:test';
import { argumentsForRun, assertDiskBacked, directoryBytes, failureCode, mountForPath, readJSON,
  runChild, safeCase, safeDevices, safeEnvironment, safeMount, traceAggregate } from '../scripts/storage-diagnostic-lib.mjs';

test('bounds every workload option and does not accept another output disk or a FULL override', () => {
  assert.deepEqual(argumentsForRun([]), { samples: 300, warmup: 30, fsyncSamples: 64, timeoutSeconds: 180, trace: 'auto', keepRaw: false });
  for (const args of [['--samples=29'], ['--samples=541'], ['--warmup=31'], ['--timeout-seconds=241'], ['--timeout-seconds=NaN'],
    ['--fsync-samples=129'], ['--output=/dev/shm/faster'], ['--synchronous=NORMAL'], ['--trace=unknown'], ['--samples=30', '--samples=40']]) {
    assert.throws(() => argumentsForRun(args), /INVALID_STORAGE_ARGUMENT/);
  }
  assert.equal(argumentsForRun(['--trace=required', '--keep-raw']).trace, 'required');
});
test('mount resolution chooses the actual longest path and handles Linux escaping', () => {
  const mounts = '21 0 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n22 21 8:2 / /work rw - xfs /dev/sdb rw\n23 22 8:3 / /work/private\\040qa rw - ext4 /dev/sdc1 rw,data=ordered';
  assert.equal(mountForPath(mounts, '/work/private qa/run').majorMinor, '8:3');
  assert.equal(mountForPath(mounts, '/work/other').majorMinor, '8:2');
  assert.equal(mountForPath(mounts, '/workspace').majorMinor, '8:1');
});
test('RAM-backed actual checkout fails rather than selecting an alternative device', () => {
  for (const typeHex of ['0x1021994', '0x858458f6']) assert.throws(() => assertDiskBacked({ typeHex }), /RAM_BACKED_CHECKOUT_REFUSED/);
  assert.throws(() => assertDiskBacked({ typeHex: '0x0', mount: { fsType: 'tmpfs' } }), /RAM_BACKED_CHECKOUT_REFUSED/);
  assert.doesNotThrow(() => assertDiskBacked({ typeHex: '0xef53', mount: { fsType: 'ext4' } }));
});
test('trace summary handles resumed calls, errors and an explicit measured-time window', () => {
  const trace = '1000.100000 fdatasync(8) = 0 <0.004000>\n1000.200000 fsync(7 <unfinished ...>\n1000.210000 <... fsync resumed>) = 0 <0.010000>\n1000.300000 fcntl(8, F_SETLK, {}) = -1 EAGAIN (unavailable) <0.002000>\n+++ exited with 0 +++';
  const result = traceAggregate(trace);
  assert.equal(result.fdatasync.p99Ms, 4); assert.equal(result.fsync.calls, 1); assert.equal(result.fsync.maxMs, 10);
  assert.equal(result.fcntl.errors, 1); assert.equal(result.fcntl.summedWallMs, 2);
  const filtered = traceAggregate(trace, { fromMs: 1000200, toMs: 1000250 });
  assert.equal(filtered.fdatasync.calls, 0); assert.equal(filtered.fsync.calls, 1); assert.equal(filtered.fcntl.calls, 0);
});
test('public aggregates drop payloads, opaque mount credentials and unknown failure text', () => {
  const secret = 'PRIVATE_ACCOUNT_TOKEN';
  const value = { phase: 'sqlite', samples: 30, sqliteVersion: secret, journalMode: 'wal', verifiedFinalState: true,
    world: secret, roster: [{ playerId: secret }], writer: { synchronous: 2, private: secret }, checkpoint: { failures: 0, private: secret },
    fixture: { mapId: secret, startPhase: secret, endPhase: secret } };
  const output = JSON.stringify(safeCase(value, true)); assert.equal(output.includes(secret), false); assert.equal(output.includes('world'), false);
  const mount = safeMount({ fsType: 'cifs', source: '//server/' + secret, majorMinor: '0:12', options: 'rw', superOptions: 'password=' + secret + ',lowerdir=/private/' + secret });
  assert.equal(JSON.stringify(mount).includes(secret), false); assert.equal(mount.source, 'opaque');
  assert.equal(failureCode(new Error(secret)), 'STORAGE_DIAGNOSTIC_FAILED');
  assert.equal(failureCode(new Error('STORAGE_CHILD_TIMEOUT')), 'STORAGE_CHILD_TIMEOUT');
  assert.equal(JSON.stringify(safeEnvironment({ pressure: { cpu: { some: { avg10: secret } } }, private: secret })).includes(secret), false);
});
test('block-device summary selects the actual mount device and its parent without labels or unrelated paths', () => {
  const raw = { available: true, output: JSON.stringify({ blockdevices: [{ name: 'sda', 'maj:min': '8:0', type: 'disk', size: 1024, rota: false, ro: false,
    serial: 'PRIVATE_SERIAL', children: [{ name: 'sda1', 'maj:min': '8:1', type: 'part', size: 1024, rota: false, ro: false }] },
  { name: 'sdb', 'maj:min': '8:16', type: 'disk', size: 4096, label: 'UNRELATED' }] }) };
  const summary = safeDevices(raw, '8:1'); assert.equal(summary.mountDeviceResolved, true);
  assert.deepEqual(summary.devices.map(device => device.name), ['sda', 'sda1']);
  assert.equal(JSON.stringify(summary).includes('PRIVATE_SERIAL'), false); assert.equal(JSON.stringify(summary).includes('UNRELATED'), false);
  assert.equal(safeDevices(raw, '0:900').mountDeviceResolved, false);
});
test('JSON input and raw byte accounting are bounded', async t => {
  const path = await mkdtemp(resolve(tmpdir(), 'iva-storage-test-')); t.after(() => rm(path, { recursive: true, force: true }));
  await writeFile(resolve(path, 'small.json'), '{"ok":true}'); assert.deepEqual(await readJSON(resolve(path, 'small.json')), { ok: true });
  assert.equal(await directoryBytes(path), 11);
  await assert.rejects(readJSON(resolve(path, 'small.json'), 10), /INVALID_DIAGNOSTIC_REPORT/);
});
test('own-child timeout also terminates its traced-style descendant and keeps raw output private', async t => {
  const path = await mkdtemp(resolve(tmpdir(), 'iva-storage-child-')); t.after(() => rm(path, { recursive: true, force: true }));
  const descendant = 'process.on("SIGTERM", () => {}); const server = require("node:net").createServer(); server.listen(0, "127.0.0.1", () => console.log("CHILD_PORT=" + server.address().port + " CHILD_PID=" + process.pid));';
  const parent = 'console.log("PRIVATE_TEST_OUTPUT"); require("node:child_process").spawn(process.execPath, ["-e", ' + JSON.stringify(descendant) + '], { stdio: "inherit" }); setInterval(() => {}, 1000);';
  const result = await runChild(process.execPath, ['-e', parent], { cwd: path, logPath: resolve(path, 'child.log'), timeoutMs: 600 });
  assert.equal(result.reason, 'STORAGE_CHILD_TIMEOUT'); assert.ok(result.elapsedMs < 3000);
  assert.equal(JSON.stringify(result).includes('PRIVATE_TEST_OUTPUT'), false);
  const log = await readFile(resolve(path, 'child.log'), 'utf8'); assert.ok(log.includes('PRIVATE_TEST_OUTPUT'));
  const descendantInfo = /CHILD_PORT=(\d+) CHILD_PID=(\d+)/.exec(log); assert.ok(descendantInfo);
  t.after(() => { try { process.kill(Number(descendantInfo[2]), 'SIGKILL'); } catch { /* Already reaped. */ } });
  // SIGKILL delivery and socket teardown occur asynchronously after kill(2).
  // A surviving descendant still fails this bounded eventual-exit assertion.
  const end = performance.now() + 1000; let refused = false;
  while (performance.now() < end && !refused) {
    refused = await new Promise((resolveClosed, reject) => {
      const socket = connect(Number(descendantInfo[1]), '127.0.0.1');
      socket.once('error', error => { if (error.code === 'ECONNREFUSED') resolveClosed(true); else reject(error); });
      socket.once('connect', () => { socket.destroy(); resolveClosed(false); });
      socket.setTimeout(250, () => { socket.destroy(); reject(new Error('DESCENDANT_CHECK_TIMEOUT')); });
    });
    if (!refused) await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  assert.equal(refused, true, 'owned descendant must exit after the timeout');
});
test('missing optional tracer is an explicit unavailable process result', async t => {
  const path = await mkdtemp(resolve(tmpdir(), 'iva-storage-missing-')); t.after(() => rm(path, { recursive: true, force: true }));
  const result = await runChild(resolve(path, 'no-such-tracer'), [], { cwd: path, logPath: resolve(path, 'child.log'), timeoutMs: 1000 });
  assert.equal(result.spawnCode, 'ENOENT'); assert.equal(result.exitCode, null);
});
