import { describe, expect, it } from 'vitest';
import { canAdmit, capacityProfile, forpostDemand, ResourceProbe, sumDemand } from '../src/capacity';
import type { CapacityProfile, ResourceSample } from '../src/capacity';

const MiB = 1024 * 1024;
const profile: CapacityProfile = { schema: 'iva-realtime-capacity-1', gameId: 'forpost', artifactId: 'qa-artifact', source: 'test-fixture',
  evidence: 'Synthetic arithmetic fixture, not a measured capacity claim', maxRooms: 4, maxBodies: 224, maxBots: 24, maxConnections: 48,
  stepP99Ms: 5, roomMemoryBytes: 256 * MiB };
const resources: ResourceSample = { memoryLimitBytes: 8192 * MiB, memoryUsedBytes: 512 * MiB, availableMemoryBytes: 7680 * MiB,
  cpuCores: 2, memorySource: 'cgroup', cpuSource: 'cgroup', cpuMsPerSecond: 0, valid: true };
const empty = sumDemand([]);
function decision(changes: Partial<Parameters<typeof canAdmit>[0]> = {}) {
  return canAdmit({ demand: forpostDemand(6, 6, profile), occupied: empty, resources, maxRooms: 4,
    baselineMemoryBytes: 128 * MiB, actualConnections: 0, backlogMs: 0, draining: false, profile, ...changes });
}

describe('admission resource headroom', () => {
  it('reserves the complete legal entity envelope, temporary bots and two sockets for each human', () => {
    expect(forpostDemand(6, 6, profile)).toMatchObject({ bodies: 56, bots: 6, connections: 12, cpuMsPerSecond: 150 });
    expect(forpostDemand(2, 1, profile)).toMatchObject({ bodies: 20, bots: 2, connections: 2 });
    expect(decision()).toMatchObject({ ok: true, mode: 'test-fixture', maxRooms: 4 });
  });
  it('keeps one unmeasured room even when a larger configured cap exists', () => {
    expect(decision({ profile: undefined, occupied: forpostDemand(2, 1) })).toMatchObject({ ok: false, reason: 'ROOM_LIMIT', maxRooms: 1, mode: 'conservative' });
  });
  it.each([
    ['BODY_BUDGET', { maxBodies: 55 }], ['BOT_BUDGET', { maxBots: 5 }], ['CONNECTION_BUDGET', { maxConnections: 11 }],
  ] as const)('does not admit outside the measured %s envelope', (reason, change) => {
    expect(decision({ profile: { ...profile, ...change } }).reason).toBe(reason);
  });
  it('includes extra existing view-only sockets in the connection budget', () => {
    expect(decision({ actualConnections: 40 }).reason).toBe('CONNECTION_BUDGET');
  });
  it('preserves 25% RAM and considers remaining host memory as well as the container limit', () => {
    expect(decision({ resources: { ...resources, memoryLimitBytes: 1024 * MiB, memoryUsedBytes: 550 * MiB, availableMemoryBytes: 474 * MiB } }).reason).toBe('MEMORY_BUDGET');
    expect(decision({ resources: { ...resources, availableMemoryBytes: 128 * MiB } }).reason).toBe('MEMORY_BUDGET');
  });
  it('preserves 30% compute headroom and does not add work behind an existing simulation backlog', () => {
    expect(decision({ resources: { ...resources, cpuMsPerSecond: 1300 } }).reason).toBe('CPU_BUDGET');
    expect(decision({ backlogMs: 101 }).reason).toBe('EXISTING_BACKLOG');
    expect(decision({ draining: true }).reason).toBe('DRAINING');
  });
  it('fails conservatively when a resource metric is unavailable', () => {
    expect(decision({ resources: { ...resources, valid: false } }).reason).toBe('METRICS_UNAVAILABLE');
  });
  it('rejects an artifact mismatch, nonfinite cost and a test profile in production validation', () => {
    expect(() => capacityProfile(profile, 'qa-artifact')).toThrow('INVALID_CAPACITY_PROFILE');
    expect(() => capacityProfile(profile, 'different-artifact', true)).toThrow('INVALID_CAPACITY_PROFILE');
    expect(() => capacityProfile({ ...profile, stepP99Ms: Number.NaN }, 'qa-artifact', true)).toThrow('INVALID_CAPACITY_PROFILE');
    expect(capacityProfile({ ...profile, artifactId: 'test-fixture' }, 'actual-artifact', true)).toMatchObject({ source: 'test-fixture', artifactId: 'actual-artifact' });
  });
});

describe('container resource sampling', () => {
  it('uses numeric cgroup max/current rather than the machine-wide free memory', () => {
    const values: Record<string, string> = { '/sys/fs/cgroup/memory.max': String(1024 * MiB), '/sys/fs/cgroup/memory.current': String(900 * MiB), '/sys/fs/cgroup/cpu.max': '50000 100000' };
    const sample = new ResourceProbe(path => values[path] ?? null).sample();
    expect(sample.memorySource).toBe('cgroup'); expect(sample.memoryLimitBytes).toBeLessThanOrEqual(1024 * MiB);
    expect(sample.memoryUsedBytes).toBeGreaterThanOrEqual(900 * MiB); expect(sample.availableMemoryBytes).toBeLessThanOrEqual(124 * MiB);
    expect(sample.cpuCores).toBe(0.5); expect(sample.cpuSource).toBe('cgroup');
  });
  it('rejects an unreadable current value under a known cgroup memory limit', () => {
    const sample = new ResourceProbe(path => path === '/sys/fs/cgroup/memory.max' ? String(1024 * MiB) : null).sample();
    expect(sample.valid).toBe(false);
  });
  it('uses the tightest parent quota for a service in a nested cgroup', () => {
    const values: Record<string, string> = { '/proc/self/cgroup': '0::/service/worker',
      '/sys/fs/cgroup/cpu.max': 'max 100000', '/sys/fs/cgroup/service/cpu.max': '25000 100000', '/sys/fs/cgroup/service/worker/cpu.max': '200000 100000',
      '/sys/fs/cgroup/service/memory.max': String(512 * MiB), '/sys/fs/cgroup/service/memory.current': String(400 * MiB),
      '/sys/fs/cgroup/service/worker/memory.max': 'max' };
    const sample = new ResourceProbe(path => values[path] ?? null).sample();
    expect(sample.cpuCores).toBe(0.25); expect(sample.memoryLimitBytes).toBeLessThanOrEqual(512 * MiB);
    expect(sample.availableMemoryBytes).toBeLessThanOrEqual(112 * MiB);
  });
  it('preserves parent headroom even when the child has the smaller limit', () => {
    const values: Record<string, string> = { '/proc/self/cgroup': '0::/service/worker',
      '/sys/fs/cgroup/service/memory.max': String(2048 * MiB), '/sys/fs/cgroup/service/memory.current': String(1600 * MiB),
      '/sys/fs/cgroup/service/worker/memory.max': String(1024 * MiB), '/sys/fs/cgroup/service/worker/memory.current': String(256 * MiB) };
    const sample = new ResourceProbe(path => values[path] ?? null).sample();
    expect(sample.memoryLimitBytes).toBeLessThanOrEqual(1024 * MiB);
    expect(sample.availableMemoryBytes).toBeLessThanOrEqual(448 * MiB);
    expect(sample.memoryAdmissionHeadroomBytes).toBe(0);
    const smallDemand = forpostDemand(2, 1, { ...profile, roomMemoryBytes: 128 * MiB });
    expect(decision({ resources: sample, demand: smallDemand }).reason).toBe('MEMORY_BUDGET');
    delete values['/sys/fs/cgroup/service/memory.current'];
    expect(new ResourceProbe(path => values[path] ?? null).sample().valid).toBe(false);
  });
});
