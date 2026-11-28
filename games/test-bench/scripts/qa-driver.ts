/** Pure policy/catalog imports for the external UI test runner.
 * This file is never imported by the game and has no state/transport access. */
import { chooseBotInput } from '../src/bots';
import { PARTS } from '../src/catalog';
import type { DriveInput, LaneSnapshot, TrackDefinition } from '../src/types';

export { chooseBotInput };
export { chooseBotBlueprint } from '../src/bots';
export { PARTS };
export { PRESETS, PRESET_NAMES, SLOT_NAMES, blueprintCost, blueprintEdits } from '../src/catalog';
export { getTrack } from '../src/tracks';

export interface SentSteering {
  /** Estimated server delivery time: observed frame send time plus relay delay. */
  due: number;
  steering: number;
}
export interface KeyboardTiming {
  snapshotTimeMs: number;
  nowMs: number;
  delayMs: number;
  sentSteering: readonly SentSteering[];
}

/** External QA observations only: no simulation object or gameplay mutation. */
export interface PrecisionStallLane {
  tick: number;
  gatesPassed: number;
  resets: number;
  finished: boolean;
  cargo: readonly { status: LaneSnapshot['cargo'][number]['status']; health: number }[];
  car: { position: { x: number; z: number }; speed: number; charge: number; tilt: number };
}
export interface PrecisionStallState {
  scope: string;
  gatesPassed: number;
  resets: number;
  anchor: { x: number; z: number };
  startTick: number | null;
  lastTick: number;
  lastAcceptedSeq: number;
  /** A held R's braking must not immediately arm another reset at the same pose. */
  triggered: boolean;
}
export interface PrecisionStallSample {
  lane: Readonly<PrecisionStallLane>;
  track: Readonly<TrackDefinition>;
  /** Connection, match, epoch, stage and phase identity, supplied by the runner. */
  scope: string;
  nowMs: number;
  snapshotTimeMs: number;
  lastAcceptedSeq: number;
  /** Last actual same-scope WebSocket input; neutral if none has been observed. */
  sentInput: Readonly<DriveInput>;
  plannedInput: Readonly<DriveInput>;
}
export interface PrecisionStallEvidence {
  startTick: number;
  tick: number;
  /** Historical name: elapsed insufficient-progress ticks, which can include creep. */
  stalledTicks: number;
  gateId: string;
  gatesPassed: number;
  resets: number;
  position: { x: number; z: number };
  charge: number;
  speed: number;
  anchorDisplacement: number;
  limits: { speedBelowMps: number; displacementBelowMeters: number; minimumTicks: number };
}

const PRECISION_STALL_LIMITS = { speedBelowMps: .20, displacementBelowMeters: .30, minimumTicks: 90 } as const;
// The flat-track gate policy targets at least 1.6 m/s. The escape window uses
// at most one eighth of that speed; .30 m = .20 m/s * 90 ticks / 60 Hz.
// These are external QA-driver criteria, not gameplay or scoring rules.
/** Request the ordinary held-R action after a continuously observed upright
 * gate approach with insufficient progress, including slow creep. This repairs
 * the QA driver's missing escape behavior; it neither changes the route or
 * prediction nor claims to explain the initial bad approach. Timers use
 * authoritative lane ticks, never wall-clock jumps during recovery.
 */
export function observePrecisionStall(previous: PrecisionStallState | null, sample: PrecisionStallSample): { state: PrecisionStallState | null; restore: boolean; evidence?: PrecisionStallEvidence } {
  const { lane, track, scope, lastAcceptedSeq } = sample;
  const { car } = lane;
  const snapshotAge = sample.nowMs - sample.snapshotTimeMs;
  const valid = [lane.tick, lane.gatesPassed, lane.resets, car.position.x, car.position.z, car.speed, car.charge, car.tilt, snapshotAge, lastAcceptedSeq].every(Number.isFinite);
  const gate = track.orderedGates[lane.gatesPassed];
  const hasCargo = lane.cargo.some(item => item.status === 'secured' && item.health > 0);
  if (!valid || !scope || track.id !== 'precision' || lane.finished || !gate || !hasCargo || car.charge <= 0 || car.tilt >= 65 || snapshotAge < 0 || snapshotAge > 300 || lastAcceptedSeq < 0) return { state: null, restore: false };
  const distanceToGate = gate.z - car.position.z;
  if (distanceToGate <= 0 || distanceToGate > 1.5) return { state: null, restore: false };

  let state = previous;
  const moved = state && Math.hypot(car.position.x - state.anchor.x, car.position.z - state.anchor.z) >= PRECISION_STALL_LIMITS.displacementBelowMeters;
  if (!state || state.scope !== scope || state.gatesPassed !== lane.gatesPassed || state.resets !== lane.resets || lane.tick < state.lastTick || lastAcceptedSeq < state.lastAcceptedSeq || moved) {
    state = { scope, gatesPassed: lane.gatesPassed, resets: lane.resets, anchor: { x: car.position.x, z: car.position.z }, startTick: null, lastTick: lane.tick, lastAcceptedSeq, triggered: false };
  }
  const advanced = lane.tick > state.lastTick;
  const uninterrupted = lane.tick - state.lastTick <= 18 && (!advanced || lastAcceptedSeq > state.lastAcceptedSeq);
  const driving = sample.sentInput.throttle > .05 && !sample.sentInput.brake && sample.plannedInput.throttle > .05 && !sample.plannedInput.brake;
  const eligible = uninterrupted && driving && Math.abs(car.speed) < PRECISION_STALL_LIMITS.speedBelowMps;
  // Braking clears accumulation. A triggered latch remains until a real scope,
  // gate, reset or position change so Space+R cannot request R repeatedly.
  const startTick = eligible ? state.startTick ?? lane.tick : null;
  const next = { ...state, startTick, lastTick: lane.tick, lastAcceptedSeq };
  if (!eligible || next.triggered || startTick === null || lane.tick - startTick < PRECISION_STALL_LIMITS.minimumTicks) return { state: next, restore: false };
  return {
    state: { ...next, triggered: true }, restore: true,
    evidence: { startTick, tick: lane.tick, stalledTicks: lane.tick - startTick, gateId: gate.id, gatesPassed: lane.gatesPassed, resets: lane.resets, position: { x: car.position.x, z: car.position.z }, charge: car.charge, speed: car.speed, anchorDisplacement: Math.hypot(car.position.x - next.anchor.x, car.position.z - next.anchor.z), limits: { ...PRECISION_STALL_LIMITS } },
  };
}

/** The external driver's exact keyboard policy, shared with its headless replay.
 * Precision's optional estimate uses only a received own-lane snapshot and
 * actual sent-input history. It never advances or changes the real simulation.
 * Clock timestamps must share the isolated server/runner host's time origin.
 */
export function chooseBrowserKeyboardInput(lane: Readonly<LaneSnapshot>, track: TrackDefinition, timing?: KeyboardTiming) {
  const limit = (33 - 16 * Math.min(1, lane.car.speed / PARTS[lane.blueprint.motor].maxSpeed!)) * Math.PI / 180;
  let planned = lane;
  let actual = lane.car.wheels[0]?.steering ?? 0;
  let prediction: { horizonMs: number; steps: number; historyFrames: number; observedWheelAngle: number; estimatedWheelAngle: number } | null = null;
  if (track.id === 'precision' && timing && timing.delayMs > 0) {
    const horizonMs = timing.nowMs + timing.delayMs - timing.snapshotTimeMs;
    if (![timing.nowMs, timing.snapshotTimeMs, timing.delayMs, horizonMs].every(Number.isFinite) || horizonMs < 0) throw new Error('Invalid shared-clock keyboard prediction timing');
    const horizon = horizonMs / 1000;
    planned = { ...lane, car: { ...lane.car, position: { ...lane.car.position, x: lane.car.position.x + lane.car.velocity.x * horizon, z: lane.car.position.z + lane.car.velocity.z * horizon }, yaw: lane.car.yaw + lane.car.angularVelocity.y * horizon } };
    const stepMs = 1000 / 60;
    const steps = Math.ceil(horizonMs / stepMs - 1e-8);
    let held = 0;
    for (let step = 0; step < steps; step++) {
      const at = timing.snapshotTimeMs + step * stepMs;
      // Preserve send order, including the last input already delivered before
      // the snapshot. The observed wheel angle itself is never reset to zero.
      for (const sent of timing.sentSteering) if (sent.due <= at + 1e-7) held = sent.steering;
      actual += Math.max(-2.8 / 60, Math.min(2.8 / 60, held * limit - actual));
    }
    prediction = { horizonMs, steps, historyFrames: timing.sentSteering.length, observedWheelAngle: lane.car.wheels[0]?.steering ?? 0, estimatedWheelAngle: actual };
  }
  const decision = chooseBotInput(planned, track, 'normal');
  const desired = decision.input.steering * limit;
  const steering = desired > .02 ? actual < desired ? 1 : 0 : desired < -.02 ? actual > desired ? -1 : 0 : 0;
  return { decision, steering, prediction };
}
