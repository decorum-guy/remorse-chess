/** A bounded diagnostic on this checkout's actual disk. Never a release gate substitute. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceTrace, traceSummary, verifySourceTrace } from './source-identity.mjs';
import { argumentsForRun, assertDiskBacked, directoryBytes, environmentSnapshot, failureCode, hostMetadata,
  RAW_LIMIT_BYTES, readJSON, readTail, runChild, safeCase, safeDevices, safeEnvironment, safeMount, traceAggregate } from './storage-diagnostic-lib.mjs';

process.umask(0o077);
const root = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
let options, directory, deadline, monitor, monitorTask = null;
const started = performance.now(), controller = new AbortController();
const report = { format: 'iva-storage-diagnostic-1', complete: false, kind: 'Bounded checkout storage diagnosis; not browser, capacity, deployment or power-loss acceptance',
  cases: [], phaseEnvironment: [], trace: { requested: null, status: 'not-attempted', timingIncludesTracerOverhead: true }, failures: [] };
const interrupt = () => controller.abort('STORAGE_DIAGNOSTIC_INTERRUPTED');
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const check = () => { if (controller.signal.aborted) throw new Error(String(controller.signal.reason)); };
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const remaining = () => Math.max(1, options.timeoutSeconds * 1000 - (performance.now() - started));
async function child(command, args, name, maximumMs = remaining()) {
  check();
  const outcome = await runChild(command, args, { cwd: root, logPath: resolve(directory, 'raw', name + '.log'),
    timeoutMs: Math.min(remaining(), maximumMs), signal: controller.signal });
  check(); return outcome;
}
function requireSuccess(outcome, code) {
  if (outcome.reason) throw new Error(outcome.reason);
  if (outcome.exitCode !== 0 || outcome.signal || outcome.spawnCode) throw new Error(code);
}
async function compileIdentity(codeDirectory) {
  const files = [], visit = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push(relative(codeDirectory, file));
      else throw new Error('UNEXPECTED_DIAGNOSTIC_FILE');
    }
  };
  await visit(codeDirectory); files.sort(); const hash = createHash('sha256'), rows = [];
  for (const path of files) { const bytes = await readFile(resolve(codeDirectory, path)); hash.update(path); hash.update(bytes);
    rows.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  const require = createRequire(import.meta.url);
  return { diagnosticExecutableSha256: hash.digest('hex'), executableFiles: rows, target: 'node24',
    nativeSqliteSha256: null,
    nativeSqlitePackageVersion: JSON.parse(await readFile(require.resolve('better-sqlite3/package.json'), 'utf8')).version,
    scope: 'Isolated diagnostic bundle built from the recorded source; not dist-realtime or a production image identity' };
}
async function phase(name, kind, traced) {
  report.stage = name;
  const path = resolve(directory, 'raw', name); await mkdir(path, { mode: 0o700 });
  const before = await environmentSnapshot(path); assertDiskBacked(before.filesystem);
  report.phaseEnvironment.push({ name, before });
  const args = [resolve(directory, 'raw/code/storage-case.js'), kind, path,
    String(kind === 'fsync' ? options.fsyncSamples : options.samples), String(kind === 'fsync' ? Math.min(options.warmup, 8) : options.warmup)];
  const traceArgs = ['-ff', '-qq', '-ttt', '-T', '-e', 'trace=fsync,fdatasync,fcntl', '-o', resolve(path, 'syscalls'), process.execPath, ...args];
  const outcome = await child(traced ? 'strace' : process.execPath, traced ? traceArgs : args, name);
  requireSuccess(outcome, 'STORAGE_CASE_FAILED');
  const value = await readJSON(resolve(path, 'result.json')); report.cases.push({ name, traced, value });
  report.phaseEnvironment.at(-1).after = await environmentSnapshot(path);
  if (kind === 'sqlite' && (value.writer?.synchronous !== 2 || value.writer?.walAutoCheckpoint !== 0 || value.journalMode !== 'wal' ||
    value.samples !== options.samples || value.verifiedFinalState !== true || value.checkpoint?.failures !== 0)) throw new Error('STORAGE_CASE_INVARIANT_FAILED');
  if (kind === 'sqlite') {
    if (!/^[0-9a-f]{64}$/.test(value.nativeSqlite?.sha256) || value.nativeSqlite.packageVersion !== report.build.nativeSqlitePackageVersion ||
      report.build.nativeSqliteSha256 !== null && report.build.nativeSqliteSha256 !== value.nativeSqlite.sha256) throw new Error('NATIVE_SQLITE_IDENTITY_MISMATCH');
    report.build.nativeSqliteSha256 = value.nativeSqlite.sha256;
  }
  if (kind === 'fsync' && value.samples !== options.fsyncSamples) throw new Error('STORAGE_CASE_INVARIANT_FAILED');
  if (traced) {
    const files = (await readdir(path)).filter(file => /^syscalls(?:\.\d+)?$/.test(file)).sort();
    const samples = await readJSON(resolve(path, 'samples.json'));
    const measuredWindow = { fromMs: samples[0].at, toMs: samples.at(-1).at + samples.at(-1).commitMs + 1 };
    const perThread = [], all = [];
    for (const file of files) {
      const text = await readFile(resolve(path, file), 'utf8'), thread = Number(file.split('.')[1]) || null; all.push(text);
      perThread.push({ thread, writerMainThread: thread === value.processId, calls: traceAggregate(text), measuredWindowCalls: traceAggregate(text, measuredWindow) });
    }
    const aggregate = traceAggregate(all.join('\n'));
    if (aggregate.fsync.calls + aggregate.fdatasync.calls === 0) throw new Error('TRACE_SYNC_CALLS_MISSING');
    report.trace = { ...report.trace, status: 'captured', files: files.length, aggregate, perThread,
      measuredWindow, measuredWindowCalls: traceAggregate(all.join('\n'), measuredWindow), windowClockPrecisionMs: 1,
      scope: 'All child threads plus a timestamp-filtered measured window; summed syscall time can overlap between threads; traced latency includes tracer overhead' };
  }
}
try {
  options = argumentsForRun(process.argv.slice(2)); report.options = options; report.trace.requested = options.trace;
  deadline = setTimeout(() => controller.abort('STORAGE_DIAGNOSTIC_TIMEOUT'), options.timeoutSeconds * 1000);
  const qa = resolve(root, '.qa'); await mkdir(qa, { recursive: true, mode: 0o700 });
  if (!(await lstat(qa)).isDirectory() || await realpath(qa) !== qa) throw new Error('CHECKOUT_QA_DIRECTORY_REQUIRED');
  directory = await mkdtemp(resolve(qa, 'storage-')); await chmod(directory, 0o700); await mkdir(resolve(directory, 'raw'), { mode: 0o700 });
  report.directory = relative(root, directory); report.maxRawBytes = RAW_LIMIT_BYTES;
  monitor = setInterval(() => {
    if (monitorTask) return;
    monitorTask = directoryBytes(resolve(directory, 'raw')).then(bytes => { report.peakRawBytes = Math.max(report.peakRawBytes ?? 0, bytes);
      if (bytes > RAW_LIMIT_BYTES) controller.abort('STORAGE_RAW_LIMIT');
    }, () => { controller.abort('STORAGE_RAW_INSPECTION_FAILED'); }).finally(() => { monitorTask = null; });
  }, 250);
  report.host = await hostMetadata(root, directory); report.environmentBefore = await environmentSnapshot(directory);
  assertDiskBacked(report.environmentBefore.filesystem);
  const source = await createSourceTrace(root);
  if (process.env.IVA_BUILD_SHA && process.env.IVA_BUILD_SHA !== source.gitCommit) throw new Error('SOURCE_BUILD_IDENTITY_MISMATCH');
  report.source = traceSummary(source); report.buildRevision = source.gitCommit;
  await save(resolve(directory, 'source.json'), source);
  report.stage = 'compile';
  requireSuccess(await child(process.execPath, [resolve(root, 'apps/realtime-server/scripts/storage-diagnostic-build.mjs'), directory], 'build', 45_000), 'DIAGNOSTIC_BUILD_FAILED');
  report.stage = 'build-identity'; report.build = await compileIdentity(resolve(directory, 'raw/code'));
  await verifySourceTrace(root, source);
  await phase('file-baseline', 'fsync', false);
  await phase('sqlite-baseline', 'sqlite', false);
  if (options.trace !== 'off') {
    report.stage = 'trace-availability';
    const probe = await child('strace', ['-f', '-qq', '-ttt', '-T', '-e', 'trace=fsync,fdatasync,fcntl', '-o', resolve(directory, 'raw/trace-permission'),
      process.execPath, '--input-type=module', '-e', 'process.exit(0)'], 'trace-permission', 8000);
    if (probe.exitCode === 0 && !probe.signal && !probe.spawnCode && !probe.reason) await phase('sqlite-traced', 'sqlite', true);
    else {
      const log = (await readFile(resolve(directory, 'raw/trace-permission.log'), 'utf8')).slice(0, 8192);
      report.trace.status = 'unavailable'; report.trace.reason = probe.spawnCode === 'ENOENT' ? 'STRACE_NOT_INSTALLED'
        : /(?:ptrace|PTRACE|Operation not permitted|Permission denied)/.test(log) ? 'PTRACE_UNAVAILABLE' : probe.reason ?? 'TRACE_PROBE_FAILED';
      if (options.trace === 'required') throw new Error('REQUIRED_TRACE_UNAVAILABLE');
    }
  } else report.trace.status = 'disabled-explicitly';
  await verifySourceTrace(root, source);
  if (await directoryBytes(resolve(directory, 'raw')) > RAW_LIMIT_BYTES) throw new Error('STORAGE_RAW_LIMIT');
  check(); report.complete = true; report.stage = 'completed';
} catch (error) {
  // Private report only, bounded. Never copied into stdout/summary.json.
  report.failureDetail = { name: String(error?.name ?? '').slice(0, 100), code: String(error?.code ?? '').slice(0, 100),
    message: String(error?.message ?? '').slice(0, 2048), stack: String(error?.stack ?? '').slice(0, 8192) };
  report.failures.push(failureCode(error)); process.exitCode = 1;
} finally {
  clearTimeout(deadline); clearInterval(monitor);
  await monitorTask;
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  if (directory) {
    try { report.environmentAfter = await environmentSnapshot(directory); } catch { report.environmentAfter = null; }
    try { report.rawBytesBeforeCleanup = await directoryBytes(resolve(directory, 'raw')); }
    catch { report.rawBytesBeforeCleanup = null; }
    if (!report.complete) {
      report.failureLogs = [];
      for (const file of (await readdir(resolve(directory, 'raw'))).filter(file => /^[a-z-]+\.log$/.test(file)).slice(0, 4)) {
        report.failureLogs.push({ file, tail: await readTail(resolve(directory, 'raw', file)) });
      }
    }
    if (!options?.keepRaw) { await rm(resolve(directory, 'raw'), { recursive: true, force: true }); report.rawRetained = false; }
    else report.rawRetained = true;
  }
  report.elapsedWallMs = performance.now() - started;
  const summary = { format: report.format, complete: report.complete, kind: report.kind, stage: report.stage ?? 'prepare', directory: report.directory ?? null,
    source: report.source ?? null, buildRevision: report.buildRevision ?? null,
    build: report.build ? { diagnosticExecutableSha256: report.build.diagnosticExecutableSha256, executableFileCount: report.build.executableFiles.length,
      nativeSqliteSha256: report.build.nativeSqliteSha256, nativeSqlitePackageVersion: report.build.nativeSqlitePackageVersion, target: report.build.target } : null,
    limits: { timeoutSeconds: options?.timeoutSeconds ?? null, rawByteGuard: RAW_LIMIT_BYTES, terminationGraceMs: 1500 },
    host: report.host ? { node: report.host.node, kernel: report.host.kernel, cpuModel: report.host.cpuModel, availableParallelism: report.host.availableParallelism,
      findmntAvailable: report.host.findmnt.available, lsblkAvailable: report.host.lsblk.available,
      devices: safeDevices(report.host.lsblk, report.environmentBefore?.filesystem?.mount?.majorMinor),
      comparedLocations: report.host.filesystems.map((item, index) => ({ location: index === 0 ? 'checkout' : index === 1 ? 'diagnostic-directory' : 'read-only-comparison',
        typeHex: item.typeHex ?? null, mount: safeMount(item.mount) })) } : null,
    environmentBefore: safeEnvironment(report.environmentBefore), environmentAfter: safeEnvironment(report.environmentAfter),
    cases: report.cases.map(item => ({ name: item.name, ...safeCase(item.value, item.traced) })), trace: report.trace,
    elapsedWallMs: report.elapsedWallMs, peakRawBytes: report.peakRawBytes ?? null, rawBytesBeforeCleanup: report.rawBytesBeforeCleanup ?? null,
    rawRetained: report.rawRetained ?? false, failures: report.failures,
    interpretation: { productionCapacityAccepted: false, durabilityRelaxed: false, selectedAlternativeDisk: false,
      finalizeIsFsyncMeasurement: false, tracedAndUntracedComparableWithoutOverhead: false,
      writesOnlyOwnCheckoutQADirectory: true } };
  if (directory) { await save(resolve(directory, 'report.json'), report); await save(resolve(directory, 'summary.json'), summary); }
  console.log(JSON.stringify(summary));
}
