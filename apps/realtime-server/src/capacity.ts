import { readFileSync } from 'node:fs';
import { availableParallelism, freemem, totalmem } from 'node:os';

const MiB = 1024 * 1024;
export interface CapacityProfile {
  schema: 'iva-realtime-capacity-1'; gameId: 'forpost'; artifactId: string;
  source: 'measured' | 'test-fixture'; evidence: string;
  maxRooms: number; maxBodies: number; maxBots: number; maxConnections: number;
  stepP99Ms: number; roomMemoryBytes: number;
  /** Whole runtime process CPU milliseconds divided by committed room ticks. */
  cpuMsPerTick?: number;
}
export function capacityProfile(value: unknown, artifactId: string, allowFixture = false): CapacityProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CAPACITY_PROFILE');
  const p = value as CapacityProfile;
  if (p.schema !== 'iva-realtime-capacity-1' || p.gameId !== 'forpost' ||
    p.artifactId !== artifactId && !(allowFixture && p.source === 'test-fixture' && p.artifactId === 'test-fixture') ||
    !['measured', 'test-fixture'].includes(p.source) || p.source === 'test-fixture' && !allowFixture ||
    typeof p.evidence !== 'string' || !p.evidence.trim() || p.evidence.length > 512 ||
    ![p.maxRooms, p.maxBodies, p.maxBots, p.maxConnections, p.roomMemoryBytes].every(n => Number.isSafeInteger(n) && n > 0) ||
    p.maxRooms > 16 || p.maxBodies > 100_000 || p.maxBots > 1000 || p.maxConnections > 1000 ||
    !Number.isFinite(p.stepP99Ms) || p.stepP99Ms <= 0 || p.stepP99Ms > 1000 ||
    p.cpuMsPerTick !== undefined && (!Number.isFinite(p.cpuMsPerTick) || p.cpuMsPerTick <= 0 || p.cpuMsPerTick > 1000)) throw new Error('INVALID_CAPACITY_PROFILE');
  return { ...p, artifactId };
}
export function capacityProfileFromFile(path: string | undefined, artifactId: string): CapacityProfile | undefined {
  if (!path) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const ownArtifact = value && typeof value === 'object' && 'artifactId' in value && typeof value.artifactId === 'string' ? value.artifactId : artifactId;
  const parsed = capacityProfile(value, ownArtifact, process.env.NODE_ENV !== 'production');
  // A new build must not inherit an old build's capacity claim or prevent old
  // matches from recovering. It falls back to one unmeasured room instead.
  return parsed.source === 'measured' && parsed.artifactId !== artifactId ? undefined : capacityProfile(value, artifactId, process.env.NODE_ENV !== 'production');
}

export interface ResourceSample {
  memoryLimitBytes: number; memoryUsedBytes: number; availableMemoryBytes: number;
  /** Remaining allocation after the 25% reserve in every observed ancestor. */
  memoryAdmissionHeadroomBytes?: number;
  memorySource: 'cgroup' | 'process' | 'conservative-fallback'; cpuCores: number;
  cpuSource: 'cgroup' | 'conservative-fallback'; cpuMsPerSecond: number; valid: boolean;
}
function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function read(path: string): string | null { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } }
function amount(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Cgroup constraints take precedence over host-wide free memory/CPU counts. */
export class ResourceProbe {
  private at = performance.now();
  private cpu = process.cpuUsage();
  private recentCpu = 0;
  constructor(private readonly readSystem: (path: string) => string | null = read) {}
  reset(): void { this.at = performance.now(); this.cpu = process.cpuUsage(); this.recentCpu = 0; }
  private groupPaths(controller: string): { unified: string[]; legacy: string[] } {
    const memberships = (this.readSystem('/proc/self/cgroup') ?? '').split('\n').map(line => line.split(':'));
    const path = (unified: boolean) => memberships.find(parts => unified ? parts[0] === '0' && parts[1] === '' : parts[1]?.split(',').includes(controller))?.[2] ?? '/';
    const ancestry = (base: string, member: string) => {
      const segments = member.split('/').filter(Boolean);
      if (segments.length > 64 || segments.some(segment => segment === '.' || segment === '..' || segment.includes('\0'))) return [base];
      const result = [base];
      for (let i = 1; i <= segments.length; i++) result.unshift(base + '/' + segments.slice(0, i).join('/'));
      return result;
    };
    return { unified: ancestry('/sys/fs/cgroup', path(true)), legacy: [...ancestry('/sys/fs/cgroup/' + controller, path(false)),
      ...(controller === 'cpu' ? ancestry('/sys/fs/cgroup/cpu,cpuacct', path(false)) : [])] };
  }
  sample(): ResourceSample {
    const now = performance.now(), cpu = process.cpuUsage(), elapsed = now - this.at;
    if (elapsed >= 250) {
      this.recentCpu = Math.max(0, (cpu.user - this.cpu.user + cpu.system - this.cpu.system) / elapsed);
      this.at = now; this.cpu = cpu;
    }
    const constrained = process.constrainedMemory(), rss = process.memoryUsage().rss;
    const memoryPaths = this.groupPaths('memory');
    const memoryLimits = [...memoryPaths.unified.map(path => ({ limit: amount(this.readSystem(path + '/memory.max')), current: amount(this.readSystem(path + '/memory.current')) })),
      ...memoryPaths.legacy.map(path => ({ limit: amount(this.readSystem(path + '/memory.limit_in_bytes')), current: amount(this.readSystem(path + '/memory.usage_in_bytes')) }))]
      .filter((group): group is { limit: number; current: number | null } => group.limit !== null && group.limit < totalmem())
      .sort((a, b) => a.limit - b.limit);
    const cgroupLimit = memoryLimits[0]?.limit ?? null, cgroupCurrent = memoryLimits[0]?.current ?? null;
    // Very large v1 values mean unlimited rather than a usable allocation.
    const effectiveCgroup = cgroupLimit !== null && cgroupLimit < totalmem() ? cgroupLimit : null;
    const processLimit = positive(constrained) ? constrained : null;
    const memorySource = effectiveCgroup !== null ? 'cgroup' : processLimit !== null ? 'process' : 'conservative-fallback';
    const memoryLimitBytes = Math.min(totalmem(), effectiveCgroup ?? Number.POSITIVE_INFINITY,
      processLimit ?? Number.POSITIVE_INFINITY, memorySource === 'conservative-fallback' ? 1024 * MiB : Number.POSITIVE_INFINITY);
    const memoryUsedBytes = Math.max(rss, effectiveCgroup !== null && cgroupCurrent !== null ? cgroupCurrent : 0);
    const availableMemoryBytes = Math.max(0, Math.min(freemem(), process.availableMemory(), memoryLimitBytes - memoryUsedBytes,
      ...memoryLimits.map(group => group.limit - (group.current ?? group.limit))));
    const memoryAdmissionHeadroomBytes = Math.max(0, Math.min(memoryLimitBytes * 0.75 - memoryUsedBytes,
      ...memoryLimits.map(group => group.limit * 0.75 - (group.current ?? group.limit))));
    const cpuPaths = this.groupPaths('cpu'), cpuLimits: number[] = [];
    for (const path of cpuPaths.unified) {
      const quota = this.readSystem(path + '/cpu.max')?.split(/\s+/);
      if (quota && quota[0] !== 'max' && positive(Number(quota[0])) && positive(Number(quota[1]))) cpuLimits.push(Number(quota[0]) / Number(quota[1]));
    }
    for (const path of cpuPaths.legacy) {
      const quota = amount(this.readSystem(path + '/cpu.cfs_quota_us')), period = amount(this.readSystem(path + '/cpu.cfs_period_us'));
      if (quota !== null && period !== null) cpuLimits.push(quota / period);
    }
    const cpuLimit = cpuLimits.length ? Math.min(...cpuLimits) : null;
    return { memoryLimitBytes, memoryUsedBytes, availableMemoryBytes, memoryAdmissionHeadroomBytes, memorySource,
      cpuCores: Math.min(2, availableParallelism(), cpuLimit ?? 1), cpuSource: cpuLimit === null ? 'conservative-fallback' : 'cgroup',
      cpuMsPerSecond: this.recentCpu, valid: positive(memoryLimitBytes) && positive(availableMemoryBytes) &&
        // A cgroup limit with unavailable usage cannot be replaced by host free RAM.
        memoryLimits.every(group => group.current !== null) };
  }
}

export interface CapacityDemand { rooms: number; bodies: number; bots: number; connections: number; memoryBytes: number; cpuMsPerSecond: number }
export function forpostDemand(participants: number, humans: number, profile?: CapacityProfile): CapacityDemand {
  // Per participant: fighter + builder + two drones + five buildings; two transports.
  // Every human seat may temporarily become a bot. Reserve two sockets per human.
  return { rooms: 1, bodies: participants * 9 + 2, bots: participants, connections: humans * 2,
    memoryBytes: profile?.roomMemoryBytes ?? 256 * MiB, cpuMsPerSecond: (profile?.cpuMsPerTick ?? profile?.stepP99Ms ?? 1000 / 60) * 30 };
}
export function sumDemand(values: CapacityDemand[]): CapacityDemand {
  const total: CapacityDemand = { rooms: 0, bodies: 0, bots: 0, connections: 0, memoryBytes: 0, cpuMsPerSecond: 0 };
  for (const value of values) for (const key of Object.keys(total) as (keyof CapacityDemand)[]) total[key] += value[key];
  return total;
}
export type CapacityReason = 'READY' | 'DRAINING' | 'ROOM_LIMIT' | 'BODY_BUDGET' | 'BOT_BUDGET' | 'CONNECTION_BUDGET' | 'MEMORY_BUDGET' | 'CPU_BUDGET' | 'EXISTING_BACKLOG' | 'METRICS_UNAVAILABLE';
export interface CapacityDecision { ok: boolean; reason: CapacityReason; mode: 'measured' | 'test-fixture' | 'conservative'; maxRooms: number }
export function canAdmit(input: { demand: CapacityDemand; occupied: CapacityDemand; resources: ResourceSample;
  maxRooms: number; baselineMemoryBytes: number; actualConnections: number; backlogMs: number; draining: boolean; profile?: CapacityProfile }): CapacityDecision {
  const p = input.profile, maxRooms = Math.min(input.maxRooms, p?.maxRooms ?? 1), mode = p?.source ?? 'conservative';
  const result = (reason: CapacityReason): CapacityDecision => ({ ok: reason === 'READY', reason, mode, maxRooms });
  if (input.draining) return result('DRAINING');
  const r = input.resources;
  if (!r.valid || !positive(r.cpuCores) || !Number.isFinite(r.cpuMsPerSecond)) return result('METRICS_UNAVAILABLE');
  const next = sumDemand([input.occupied, input.demand]);
  if (next.rooms > maxRooms) return result('ROOM_LIMIT');
  if (next.bodies > (p?.maxBodies ?? 56)) return result('BODY_BUDGET');
  if (next.bots > (p?.maxBots ?? 6)) return result('BOT_BUDGET');
  if (Math.max(input.occupied.connections, input.actualConnections) + input.demand.connections > (p?.maxConnections ?? 12)) return result('CONNECTION_BUDGET');
  const projectedMemory = Math.max(r.memoryUsedBytes, input.baselineMemoryBytes + input.occupied.memoryBytes) + input.demand.memoryBytes;
  if (projectedMemory > r.memoryLimitBytes * 0.75 || projectedMemory - r.memoryUsedBytes > r.availableMemoryBytes - r.memoryLimitBytes * 0.25 ||
    r.memoryAdmissionHeadroomBytes !== undefined && projectedMemory - r.memoryUsedBytes > r.memoryAdmissionHeadroomBytes) return result('MEMORY_BUDGET');
  if (Math.max(r.cpuMsPerSecond, input.occupied.cpuMsPerSecond) + input.demand.cpuMsPerSecond > r.cpuCores * 1000 * 0.7) return result('CPU_BUDGET');
  if (input.backlogMs > 100) return result('EXISTING_BACKLOG');
  return result('READY');
}
