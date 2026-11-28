import { describe, expect, it } from 'vitest';
import { observePrecisionStall, type PrecisionStallSample, type PrecisionStallState } from '../scripts/qa-driver';
import { getTrack } from '../src/tracks';

const START = 2960;
const FORWARD = { throttle: 1, steering: 0, brake: false };
const BRAKE = { throttle: 0, steering: 0, brake: true };

/** Pose, speed, charge, cargo, tick and acknowledgement are copied from Bob's
 * first retained Precision tail observation in candidate8 RTT120 job141041478368
 * (run46165328742, checkout77043f7bd267cde87662c1542cea83fb0a4ac873).
 * The compact browser record did NOT contain tilt. Upright tilt=0 below is an
 * explicit unit-test precondition, not a claimed browser measurement.
 * Subsequent regular 15Hz samples are synthetic unit observations; the saved
 * browser tail was too sparse to prove this detector's continuous-time gate.
 */
function sample(tick = START): PrecisionStallSample {
  const serverTime = 1795883726497 + (tick - START) * 1000 / 60;
  return {
    scope: 'connection3/match/epoch-after-restart/stage1/phase11',
    track: getTrack('precision', true),
    nowMs: serverTime + 85,
    snapshotTimeMs: serverTime,
    lastAcceptedSeq: 2222 + Math.floor((tick - START) / 2),
    sentInput: { ...FORWARD },
    plannedInput: { ...FORWARD },
    lane: {
      tick, gatesPassed: 1, resets: 0, finished: false,
      car: { position: { x: -1.4926316738128662, z: 16.774662017822266 }, speed: 0.0006099435800771421, charge: 14.024999999997615, tilt: 0 },
      cargo: [{ status: 'secured', health: 100 }, { status: 'secured', health: 100 }, { status: 'secured', health: 100 }],
    },
  };
}

/** Actual Alice endpoints from Direct10 job141061718269, checkout
 * a48f8e67ee345e5e9582b1d02b13a5a055a6ccb2: final charged creep before gate4.
 * Only these endpoints were recorded. Linear interpolation, regular 15Hz
 * samples, advancing 30Hz acknowledgements and continuous gas below are
 * explicitly SYNTHETIC unit-test observations, not a browser/physics replay.
 */
const ALICE_CREEP = [
  { tick: 2951, x: 1.330232858657837, z: 30.2901611328125, speed: .09156064004906422, charge: 3.9125000000011356, tilt: 2.73560044127562 },
  { tick: 2984, x: 1.3557195663452148, z: 30.332609176635742, speed: .09107950457689165, charge: 3.5000000000011298, tilt: 2.7372070091825424 },
  { tick: 3016, x: 1.377456545829773, z: 30.37484359741211, speed: .09089876358243296, charge: 3.100000000001124, tilt: 2.735082073514283 },
  { tick: 3048, x: 1.3980834484100342, z: 30.41744041442871, speed: .09085494758650955, charge: 2.7000000000011184, tilt: 2.734770232751776 },
];
function interpolatedAliceCreep(tick: number): PrecisionStallSample {
  if (tick < ALICE_CREEP[0]!.tick || tick > ALICE_CREEP.at(-1)!.tick) throw new Error('Synthetic creep fixture is outside its recorded endpoints');
  const next = ALICE_CREEP.findIndex(value => value.tick > tick);
  const right = next < 0 ? ALICE_CREEP.length - 1 : next;
  const lower = ALICE_CREEP[Math.max(0, right - 1)]!, upper = ALICE_CREEP[right]!;
  const portion = upper.tick === lower.tick ? 0 : (tick - lower.tick) / (upper.tick - lower.tick);
  const at = (key: 'x' | 'z' | 'speed' | 'charge' | 'tilt') => lower[key] + (upper[key] - lower[key]) * portion;
  const snapshotTimeMs = 1795888074593 + (tick - ALICE_CREEP[0]!.tick) * 1000 / 60;
  return {
    scope: 'synthetic-direct10-alice/connection2/match/epoch-after-restart/stage1/phase11',
    track: getTrack('precision', false), nowMs: snapshotTimeMs + 20, snapshotTimeMs,
    lastAcceptedSeq: 2401 + Math.floor((tick - ALICE_CREEP[0]!.tick) / 2),
    sentInput: { ...FORWARD }, plannedInput: { ...FORWARD },
    lane: { tick, gatesPassed: 3, resets: 1, finished: false,
      car: { position: { x: at('x'), z: at('z') }, speed: at('speed'), charge: at('charge'), tilt: at('tilt') },
      cargo: [{ status: 'secured', health: 92 }, { status: 'secured', health: 92 }, { status: 'secured', health: 92 }],
    },
  };
}

type Change = (value: PrecisionStallSample) => void;
function feed(from: number, until: number, previous: PrecisionStallState | null = null, change?: Change) {
  let state = previous;
  const triggers = [];
  for (let tick = from; tick <= until; tick += 4) {
    const observation = sample(tick);
    change?.(observation);
    const result = observePrecisionStall(state, observation);
    state = result.state;
    if (result.restore) triggers.push(result.evidence);
  }
  return { state, triggers };
}

describe('external QA Precision upright-stall observation', () => {
  it('requests one ordinary restore after 90 simulation ticks in the recorded stall shape', () => {
    const before = feed(START, START + 88);
    expect(before.triggers).toEqual([]);
    const input = sample(START + 92);
    const original = structuredClone(input);
    const result = observePrecisionStall(before.state, input);
    expect(result.restore).toBe(true);
    expect(result.evidence).toMatchObject({ startTick: START, tick: START + 92, stalledTicks: 92, gatesPassed: 1, resets: 0, charge: 14.024999999997615 });
    expect(result.evidence).toMatchObject({ speed: input.lane.car.speed, anchorDisplacement: 0, limits: { speedBelowMps: .20, displacementBelowMeters: .30, minimumTicks: 90 } });
    expect(result.evidence?.gateId).toBe(input.track.orderedGates[1]!.id);
    expect(input).toEqual(original);
    expect(feed(START + 96, START + 296, result.state).triggers).toEqual([]);
  });

  it('includes recorded Alice slow creep in an explicitly synthetic continuous 15Hz window', () => {
    let state: PrecisionStallState | null = null;
    const firstTick = ALICE_CREEP[0]!.tick;
    const anchor = interpolatedAliceCreep(firstTick).lane.car.position;
    for (let tick = firstTick; tick <= firstTick + 92; tick += 4) {
      const observation = interpolatedAliceCreep(tick), original = structuredClone(observation);
      const result = observePrecisionStall(state, observation);
      expect(result.restore).toBe(tick === firstTick + 92);
      expect(observation).toEqual(original);
      expect(observation.lane.car.speed).toBeGreaterThan(.088);
      expect(observation.lane.car.speed).toBeLessThan(.092);
      if (result.restore) {
        const displacement = Math.hypot(observation.lane.car.position.x - anchor.x, observation.lane.car.position.z - anchor.z);
        // Old .10 m progress resets prevented this 90-tick creep window, even
        // if only the old .08 m/s speed cutoff had been raised.
        expect(displacement).toBeGreaterThan(.10); expect(displacement).toBeLessThan(.30);
        expect(result.evidence).toMatchObject({ startTick: firstTick, stalledTicks: 92, gatesPassed: 3, resets: 1, speed: observation.lane.car.speed, anchorDisplacement: displacement, limits: { speedBelowMps: .20, displacementBelowMeters: .30, minimumTicks: 90 } });
      }
      state = result.state;
    }
  });

  it.each<[string, Change]>([
    ['moving chassis', value => { value.lane.car.speed = 0.4; }],
    ['speed at the creep limit', value => { value.lane.car.speed = .20; }],
    ['still loading', value => { value.lane = { ...value.lane, cargo: [{ status: 'at-dock', health: 100 }] }; }],
    ['broken cargo', value => { value.lane = { ...value.lane, cargo: [{ status: 'secured', health: 0 }] }; }],
    ['empty battery', value => { value.lane.car.charge = 0; }],
    ['finished lane', value => { value.lane = { ...value.lane, finished: true }; }],
    ['another track', value => { value.track = getTrack('fragile', true); }],
    ['passed next gate plane', value => { value.lane.car.position.z = 17.01; }],
    ['far from next gate', value => { value.lane.car.position.z = 14; }],
    ['all gates passed', value => { value.lane = { ...value.lane, gatesPassed: value.track.orderedGates.length }; }],
    ['tilted car', value => { value.lane.car.tilt = 80; }],
    ['planned braking', value => { value.plannedInput = BRAKE; }],
    ['actual sent braking', value => { value.sentInput = BRAKE; }],
    ['no observed sent throttle', value => { value.sentInput = { throttle: 0, steering: 1, brake: false }; }],
    ['stale snapshot', value => { value.nowMs = value.snapshotTimeMs + 301; }],
    ['future snapshot', value => { value.nowMs = value.snapshotTimeMs - 1; }],
    ['missing acknowledgement', value => { value.lastAcceptedSeq = -1; }],
    ['invalid pose', value => { value.lane.car.position.x = NaN; }],
  ])('does not request recovery for %s', (_name, change) => {
    expect(feed(START, START + 200, null, change).triggers).toEqual([]);
  });

  it('does not mistake ordinary continuous .4 m/s progress for gate creep', () => {
    const result = feed(START, START + 200, null, value => {
      value.lane.car.speed = .4;
      value.lane.car.position.x += .4 * (value.lane.tick - START) / 60;
    });
    expect(result.triggers).toEqual([]);
    expect(result.state?.startTick).toBeNull();
  });

  it('restarts the complete 90-tick window after the chassis accelerates above the creep limit', () => {
    const slow: Change = value => { value.lane.car.speed = .09; };
    const before = feed(START, START + 60, null, slow);
    const accelerated = feed(START + 64, START + 64, before.state, value => { value.lane.car.speed = .21; });
    expect(accelerated.state?.startTick).toBeNull();
    const slowAgain = feed(START + 68, START + 156, accelerated.state, slow);
    expect(slowAgain.triggers).toEqual([]);
    expect(feed(START + 160, START + 160, slowAgain.state, slow).triggers).toHaveLength(1);
  });

  it('requires real snapshot ticks and advancing input acknowledgements', () => {
    let state: PrecisionStallState | null = null;
    for (let i = 0; i < 100; i++) {
      // Polling a duplicate snapshot cannot turn wall-clock time into race time.
      const duplicate = sample();
      duplicate.nowMs += i;
      const result = observePrecisionStall(state, duplicate);
      expect(result.restore).toBe(false);
      state = result.state;
    }
    expect(state?.startTick).toBe(START);
    expect(feed(START + 4, START + 200, state, value => { value.lastAcceptedSeq = 2222; }).triggers).toEqual([]);
  });

  it('does not infer continuous throttling from the sparse retained browser tail', () => {
    let state: PrecisionStallState | null = null;
    // The retained tail has approximately 32-tick gaps, exceeding the detector's
    // 18-tick continuity limit. These sparse observations alone cannot trigger.
    for (let tick = START; tick <= START + 960; tick += 32) {
      const result = observePrecisionStall(state, sample(tick));
      expect(result.restore).toBe(false);
      state = result.state;
    }
  });

  it.each<[string, Change]>([
    ['reconnect or recovered phase scope', value => { value.scope += '/new-epoch'; }],
    ['normal reset counter', value => { value.lane = { ...value.lane, resets: 1 }; }],
    ['new gate', value => { value.lane = { ...value.lane, gatesPassed: 2 }; value.lane.car.position.z = 23.77; }],
    // The anchor must reset at meaningful .30 m progress, not at the old .10 m
    // threshold that repeatedly discarded Alice's observed slow-creep window.
    ['actual position progress', value => { value.lane.car.position.x += 0.31; }],
  ])('starts a fresh observation window after %s', (_name, change) => {
    const before = feed(START, START + 88);
    const reset = feed(START + 92, START + 180, before.state, change);
    expect(reset.triggers).toEqual([]);
    expect(reset.state?.startTick).toBe(START + 92);
    expect(feed(START + 184, START + 184, reset.state, change).triggers).toHaveLength(1);
  });

  it('clears accumulated time on braking, but retains a triggered latch during the held R', () => {
    const before = feed(START, START + 60);
    const braking = feed(START + 64, START + 68, before.state, value => { value.sentInput = BRAKE; });
    expect(braking.state?.startTick).toBeNull();
    const resumed = feed(START + 72, START + 160, braking.state);
    expect(resumed.triggers).toEqual([]);
    const triggered = feed(START + 164, START + 164, resumed.state);
    expect(triggered.triggers).toHaveLength(1);
    const heldR = feed(START + 168, START + 212, triggered.state, value => { value.sentInput = value.plannedInput = BRAKE; });
    expect(heldR.state?.triggered).toBe(true);
    expect(feed(START + 216, START + 416, heldR.state).triggers).toEqual([]);
    // Only an observed actual reset (or another real scope/progress boundary)
    // rearms the request; releasing the R key alone does not.
    expect(feed(START + 420, START + 512, heldR.state, value => { value.lane = { ...value.lane, resets: 1 }; }).triggers).toHaveLength(1);
  });

  it('clears an incomplete observation on a server tick rollback', () => {
    const before = feed(START, START + 88);
    const rewind = observePrecisionStall(before.state, sample(START + 40));
    expect(rewind.restore).toBe(false);
    expect(rewind.state?.startTick).toBe(START + 40);
    expect(feed(START + 44, START + 128, rewind.state).triggers).toEqual([]);
    expect(feed(START + 44, START + 132, rewind.state).triggers).toHaveLength(1);
  });
});
