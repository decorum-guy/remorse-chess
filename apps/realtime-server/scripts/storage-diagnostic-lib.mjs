/** Bounded process and metadata helpers; no game data or credentials on stdout. */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readFile, readdir, lstat, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { availableParallelism, cpus, release, tmpdir } from 'node:os';
import { cgroupSnapshot } from './load-summary.mjs';

const execute = promisify(execFile);
export const RAW_LIMIT_BYTES = 32 * 1024 * 1024;
const failureCodes = new Set(['INVALID_STORAGE_ARGUMENT', 'UNEXPECTED_DIAGNOSTIC_FILE', 'INVALID_DIAGNOSTIC_REPORT',
  'STORAGE_CHILD_TIMEOUT', 'STORAGE_DIAGNOSTIC_TIMEOUT', 'STORAGE_DIAGNOSTIC_INTERRUPTED', 'RAM_BACKED_CHECKOUT_REFUSED',
  'STORAGE_RAW_LIMIT', 'STORAGE_RAW_INSPECTION_FAILED', 'CHECKOUT_QA_DIRECTORY_REQUIRED', 'SOURCE_BUILD_IDENTITY_MISMATCH',
  'DIAGNOSTIC_BUILD_FAILED', 'STORAGE_CASE_FAILED', 'STORAGE_CASE_INVARIANT_FAILED', 'TRACE_SYNC_CALLS_MISSING',
  'REQUIRED_TRACE_UNAVAILABLE', 'SOURCE_TRACE_MISMATCH', 'SOURCE_FILE_HASH_MISMATCH', 'SOURCE_SYMLINK_OR_SPECIAL_FILE', 'NATIVE_SQLITE_IDENTITY_MISMATCH']);
export function failureCode(error) { return failureCodes.has(error?.message) ? error.message : 'STORAGE_DIAGNOSTIC_FAILED'; }
export function argumentsForRun(args) {
  const result = { samples: 300, warmup: 30, fsyncSamples: 64, timeoutSeconds: 180, trace: 'auto', keepRaw: false };
  const seen = new Set();
  for (const argument of args) {
    if (argument === '--keep-raw' && !seen.has('keepRaw')) { result.keepRaw = true; seen.add('keepRaw'); continue; }
    const match = /^--(samples|warmup|fsync-samples|timeout-seconds|trace)=(.+)$/.exec(argument);
    if (!match || seen.has(match[1])) throw new Error('INVALID_STORAGE_ARGUMENT'); seen.add(match[1]);
    const [, key, value] = match;
    if (key === 'trace') { if (!['auto', 'off', 'required'].includes(value)) throw new Error('INVALID_STORAGE_ARGUMENT'); result.trace = value; }
    else {
      if (!/^\d+$/.test(value)) throw new Error('INVALID_STORAGE_ARGUMENT');
      const property = { samples: 'samples', warmup: 'warmup', 'fsync-samples': 'fsyncSamples', 'timeout-seconds': 'timeoutSeconds' }[key];
      result[property] = Number(value);
    }
  }
  if (result.samples < 30 || result.samples > 540 || result.warmup < 0 || result.warmup > 30 ||
    result.fsyncSamples < 8 || result.fsyncSamples > 128 || result.timeoutSeconds < 30 || result.timeoutSeconds > 240) throw new Error('INVALID_STORAGE_ARGUMENT');
  return result;
}
export async function directoryBytes(path) {
  let bytes = 0;
  for (const item of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, item.name);
    if (item.isDirectory()) bytes += await directoryBytes(child);
    else if (item.isFile()) bytes += (await lstat(child)).size;
    else throw new Error('UNEXPECTED_DIAGNOSTIC_FILE');
  }
  return bytes;
}
export async function readJSON(path, maxBytes = 2 * 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('INVALID_DIAGNOSTIC_REPORT');
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function readTail(path, limit = 16 * 1024) {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size, bytes = Buffer.alloc(Math.min(size, limit));
    const result = await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return bytes.subarray(0, result.bytesRead).toString('utf8');
  } finally { await file.close(); }
}
export async function runChild(command, args, options) {
  if (options.signal?.aborted) throw new Error(String(options.signal.reason));
  const log = await open(options.logPath, 'wx', 0o600), started = performance.now();
  return await new Promise(resolveResult => {
    let child, timer, escalation, stopping = null, settled = false;
    const group = process.platform === 'linux';
    const kill = signal => {
      if (!child?.pid) return;
      try { if (group) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
    };
    const finish = (exitCode, signal, spawnCode = null) => {
      if (settled) return; settled = true;
      if (stopping) kill('SIGKILL');
      clearTimeout(timer); clearTimeout(escalation); options.signal?.removeEventListener('abort', abort);
      void log.close().finally(() => resolveResult({ exitCode, signal, spawnCode, reason: stopping, elapsedMs: performance.now() - started })).catch(() => {});
    };
    const stop = reason => {
      if (stopping || settled) return; stopping = reason; kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 1500);
    };
    const abort = () => stop(String(options.signal.reason ?? 'STORAGE_DIAGNOSTIC_INTERRUPTED'));
    try { child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', log.fd, log.fd], detached: group, env: options.env ?? process.env }); }
    catch { finish(null, null, 'SPAWN_FAILED'); return; }
    child.once('error', error => finish(null, null, error.code === 'ENOENT' ? 'ENOENT' : 'SPAWN_FAILED'));
    child.once('close', (code, signal) => finish(code, signal));
    timer = setTimeout(() => stop('STORAGE_CHILD_TIMEOUT'), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

const unescapeMount = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
export function mountForPath(text, path) {
  let selected = null;
  for (const line of text.trim().split('\n')) {
    const fields = line.split(' '), separator = fields.indexOf('-');
    if (separator < 6 || !/^\d+:\d+$/.test(fields[2])) continue;
    const target = unescapeMount(fields[4]);
    if (path !== target && !path.startsWith(target === '/' ? '/' : target + '/')) continue;
    if (!selected || target.length > selected.target.length) selected = { target, majorMinor: fields[2], options: fields[5],
      fsType: fields[separator + 1], source: unescapeMount(fields[separator + 2] ?? ''), superOptions: fields[separator + 3] ?? '' };
  }
  return selected;
}
export function safeMount(mount) {
  if (!mount) return { available: false };
  const fsType = /^[a-zA-Z0-9._-]{1,64}$/.test(mount.fsType) ? mount.fsType : 'unknown';
  const source = /^\/dev\/[a-zA-Z0-9/_-]{1,120}$/.test(mount.source) || ['overlay', 'tmpfs', 'ramfs', 'rootfs'].includes(mount.source) ? mount.source : 'opaque';
  const options = [...new Set((mount.options + ',' + mount.superOptions).split(',').map(value => {
    const [name, argument] = value.split('=');
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) return null;
    return ['barrier', 'data', 'commit', 'discard'].includes(name) && /^[a-zA-Z0-9_-]{1,30}$/.test(argument ?? '') ? name + '=' + argument : name;
  }).filter(Boolean))];
  return { available: true, fsType, source, majorMinor: /^\d+:\d+$/.test(mount.majorMinor) ? mount.majorMinor : null, options };
}
export function assertDiskBacked(filesystem) {
  if (['0x1021994', '0x858458f6'].includes(filesystem.typeHex) || ['tmpfs', 'ramfs'].includes(filesystem.mount?.fsType)) throw new Error('RAM_BACKED_CHECKOUT_REFUSED');
}
async function optionalText(path) { try { return await readFile(path, 'utf8'); } catch { return null; } }
async function optionalCommand(command, args) {
  try { return { available: true, output: (await execute(command, args, { timeout: 3000, maxBuffer: 512 * 1024 })).stdout }; }
  catch (error) { return { available: false, reason: error.code === 'ENOENT' ? 'NOT_INSTALLED' : 'COMMAND_FAILED' }; }
}
export async function filesystemMetadata(path) {
  const value = await statfs(path, { bigint: true }), mount = mountForPath(await optionalText('/proc/self/mountinfo') ?? '', path);
  return { path, typeHex: '0x' + BigInt.asUintN(32, value.type).toString(16), blockSize: Number(value.bsize),
    blocks: Number(value.blocks), freeBlocks: Number(value.bfree), availableBlocks: Number(value.bavail), files: Number(value.files), freeFiles: Number(value.ffree), mount };
}
export async function environmentSnapshot(directory) {
  const pressure = {};
  for (const kind of ['cpu', 'io', 'memory']) {
    const raw = await optionalText('/proc/pressure/' + kind); const rows = {};
    if (raw) for (const line of raw.trim().split('\n')) {
      const [name, ...parts] = line.split(' '); if (!['some', 'full'].includes(name)) continue;
      rows[name] = Object.fromEntries(parts.map(part => part.split('=')).filter(([key, value]) => ['avg10', 'avg60', 'avg300', 'total'].includes(key) && /^\d+(?:\.\d+)?$/.test(value)).map(([key, value]) => [key, Number(value)]));
    }
    pressure[kind] = { available: !!raw, ...rows };
  }
  const filesystem = await filesystemMetadata(directory);
  return { observedAt: Date.now(), pressure, cgroup: await cgroupSnapshot(), filesystem };
}
export async function hostMetadata(root, directory) {
  const paths = [...new Set([root, directory, ...(process.env.RUNNER_TEMP ? [process.env.RUNNER_TEMP] : []), tmpdir()])];
  const filesystems = [];
  for (const path of paths) try { filesystems.push(await filesystemMetadata(path)); } catch { filesystems.push({ path, unavailable: true }); }
  const [findmnt, lsblk] = await Promise.all([
    optionalCommand('findmnt', ['--json', '--target', directory, '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN']),
    optionalCommand('lsblk', ['--json', '--bytes', '--output', 'NAME,MAJ:MIN,TYPE,SIZE,ROTA,RO']),
  ]);
  return { node: process.version, kernel: release(), cpuModel: cpus()[0]?.model ?? null, availableParallelism: availableParallelism(),
    checkout: root, directory, filesystems, findmnt, lsblk };
}
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const numeric = (value, fields) => Object.fromEntries(fields.map(field => [field, finite(value?.[field])]));
const metric = value => numeric(value, ['samples', 'p50Ms', 'p95Ms', 'p99Ms', 'maxMs', 'meanMs', 'over50Ms']);
export function safeCase(value, traced) {
  if (!value || !['fsync', 'sqlite'].includes(value.phase)) return null;
  const base = { phase: value.phase, traced, elapsedMs: finite(value.elapsedMs), samples: finite(value.samples), warmup: finite(value.warmup),
    threadCpu: metric(value.threadCpu) };
  if (value.phase === 'fsync') return { ...base, bytesPerWrite: finite(value.bytesPerWrite), totalWrittenBytes: finite(value.totalWrittenBytes),
    write: metric(value.write), fsync: metric(value.fsync), total: metric(value.total) };
  return { ...base, cadenceMs: finite(value.cadenceMs), sqliteVersion: /^\d+\.\d+\.\d+$/.test(value.sqliteVersion) ? value.sqliteVersion : null,
    journalMode: value.journalMode === 'wal' ? 'wal' : null, verifiedFinalState: value.verifiedFinalState === true,
    fixture: { mapId: value.fixture?.mapId === 'FP01' ? 'FP01' : null, teamSize: finite(value.fixture?.teamSize),
      startTick: finite(value.fixture?.startTick), endTick: finite(value.fixture?.endTick), seed: finite(value.fixture?.seed),
      startPhase: ['preparation', 'battle'].includes(value.fixture?.startPhase) ? value.fixture.startPhase : null,
      endPhase: ['preparation', 'battle'].includes(value.fixture?.endPhase) ? value.fixture.endPhase : null },
    commit: metric(value.commit), pacingDebt: metric(value.pacingDebt),
    writer: numeric(value.writer, ['batches', 'maxTransactionMs', 'maxWorldBytes', 'maxRecordBytes', 'maxJournalBytes', 'transactionP99Ms', 'bodyP99Ms', 'finalizeP99Ms', 'walAutoCheckpoint', 'synchronous']),
    checkpoint: numeric(value.checkpoint, ['pageSize', 'walBytes', 'logFrames', 'checkpointedFrames', 'busy', 'runs', 'maxMs', 'p99Ms', 'failures']) };
}
export function traceAggregate(text, window = null) {
  const calls = { fsync: [], fdatasync: [], fcntl: [] }; const errors = { fsync: 0, fdatasync: 0, fcntl: 0 };
  for (const line of text.split('\n')) {
    const call = /(?:\b(fsync|fdatasync|fcntl)\(|<\.\.\. (fsync|fdatasync|fcntl) resumed>)/.exec(line);
    const duration = /<(\d+(?:\.\d+)?)>\s*$/.exec(line);
    if (!call || !duration) continue;
    if (window) {
      const timestamp = /^(\d+\.\d+)\s/.exec(line);
      if (!timestamp || Number(timestamp[1]) * 1000 < window.fromMs || Number(timestamp[1]) * 1000 > window.toMs) continue;
    }
    const name = call[1] ?? call[2]; calls[name].push(Number(duration[1]) * 1000); if (/= -1\b/.test(line)) errors[name]++;
  }
  return Object.fromEntries(Object.keys(calls).map(name => {
    const sorted = calls[name].sort((a, b) => a - b), p = value => sorted[Math.ceil(sorted.length * value) - 1] ?? null;
    return [name, { calls: sorted.length, errors: errors[name], p50Ms: p(0.5), p95Ms: p(0.95), p99Ms: p(0.99), maxMs: sorted.at(-1) ?? null,
      summedWallMs: sorted.reduce((sum, value) => sum + value, 0) }];
  }));
}
export function safeEnvironment(value) {
  const filesystem = value?.filesystem;
  return { observedAt: finite(value?.observedAt), filesystem: filesystem ? { typeHex: /^0x[0-9a-f]+$/.test(filesystem.typeHex) ? filesystem.typeHex : null,
    ...numeric(filesystem, ['blockSize', 'blocks', 'freeBlocks', 'availableBlocks', 'files', 'freeFiles']), mount: safeMount(filesystem.mount) } : null,
    pressure: Object.fromEntries(['cpu', 'io', 'memory'].map(kind => [kind, { available: value?.pressure?.[kind]?.available === true,
      some: numeric(value?.pressure?.[kind]?.some, ['avg10', 'avg60', 'avg300', 'total']), full: numeric(value?.pressure?.[kind]?.full, ['avg10', 'avg60', 'avg300', 'total']) }])),
    cgroup: { available: value?.cgroup?.available === true, ...numeric(value?.cgroup, ['cpuCores', 'cpuUsageUsec', 'cpuThrottledUsec', 'cpuThrottledPeriods', 'memoryLimitBytes', 'memoryUsedBytes', 'memoryPeakBytes']) } };
}
export function safeDevices(raw, majorMinor) {
  if (!raw?.available) return { available: false };
  try {
    const selected = [], walk = (items, parents = []) => {
      for (const item of items ?? []) {
        const row = { name: /^[A-Za-z0-9_-]{1,64}$/.test(item.name) ? item.name : null,
          majorMinor: /^\d+:\d+$/.test(item['maj:min']) ? item['maj:min'] : null,
          type: /^[A-Za-z0-9_-]{1,32}$/.test(item.type) ? item.type : null, bytes: finite(Number(item.size)),
          rotational: typeof item.rota === 'boolean' ? item.rota : null, readOnly: typeof item.ro === 'boolean' ? item.ro : null };
        if (row.majorMinor === majorMinor) selected.push(...parents, row);
        walk(item.children, [...parents, row]);
      }
    };
    walk(JSON.parse(raw.output).blockdevices);
    return { available: true, mountDeviceResolved: selected.length > 0, devices: selected };
  } catch { return { available: false }; }
}
