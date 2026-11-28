import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

export function parseCpuList(value) {
  assert.match(value, /^(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*))?(?:,(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*))?)*$/, 'CPU list must contain numeric IDs or ranges');
  const cpus = [];
  for (const part of value.split(',')) {
    const [first, last = first] = part.split('-').map(Number);
    assert.ok(first <= last && last <= 65535, 'Invalid or excessive CPU range');
    for (let cpu = first; cpu <= last; cpu++) cpus.push(cpu);
  }
  assert.equal(new Set(cpus).size, cpus.length, 'CPU IDs must be unique');
  return cpus.sort((a, b) => a - b);
}

export function requestedServerCpus(value, label = '--server-cpus') {
  if (value === undefined) return null;
  assert.match(value, /^(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*$/, `${label} accepts explicit comma-separated CPU IDs`);
  return parseCpuList(value);
}

function statusCpuList(path) {
  const match = readFileSync(path, 'utf8').match(/^Cpus_allowed_list:\s*(\S+)$/m);
  assert.ok(match, `CPU affinity is unavailable at ${path}`);
  return parseCpuList(match[1]);
}

export function inspectProcessAffinity(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0, 'A live owned process PID is required');
  const root = `/proc/${pid}`, processCpus = statusCpuList(`${root}/status`), masks = new Map();
  let threadCount = 0;
  for (const thread of readdirSync(`${root}/task`)) {
    try {
      const cpus = statusCpuList(`${root}/task/${thread}/status`); masks.set(cpus.join(','), cpus); threadCount += 1;
    } catch (error) { if (error.code !== 'ENOENT') throw error; /* A completed helper thread may disappear between reads. */ }
  }
  assert.ok(threadCount > 0, 'No live runtime threads were inspected');
  return { processCpus, threadCount, threadCpuSets: [...masks.values()] };
}

export function validateServerAffinity(requested, actual) {
  assert.deepEqual(actual.processCpus, requested, 'The child did not receive the requested CPU mask');
  assert.ok(actual.threadCount > 0 && actual.threadCpuSets.length > 0);
  for (const mask of actual.threadCpuSets) assert.deepEqual(mask, requested, 'A runtime thread escaped the declared CPU mask');
}

export function processCpuFraction(coreEquivalents, requested) {
  assert.ok(Number.isFinite(coreEquivalents) && coreEquivalents >= 0);
  return requested === null ? null : coreEquivalents / requested.length;
}
