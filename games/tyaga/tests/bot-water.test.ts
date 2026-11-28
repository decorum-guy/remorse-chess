import { expect, it } from 'vitest';
import { TyagaWorld } from '../src/server-world/world';
import { NEUTRAL_INPUT } from '../src/core/config';
import { angleDifference, clamp, V, yaw } from '../src/core/math';
import type { TyagaAction, TyagaInput } from '../src/core/types';
import { evidence } from './evidence';

// Fresh authored map and ordinary public actions/inputs only. This technical
// regression stops at CP1; it is neither a browser run nor a completed route.
it('a following helper reaches Quarry CP1 without repeatedly walking into deep water', async () => {
  const w = await TyagaWorld.create({ matchId: 'quarry-helper-water', mapId: 'quarry', mode: 'expedition', participants: [
    { participantId: 'human', displayName: 'Human', seatIndex: 0, bot: false },
    { participantId: 'helper', displayName: 'Helper', seatIndex: 1, bot: true },
  ] });
  const trace: unknown[] = [], rescues: unknown[] = [];
  let lastRescueId = 0, checkpointAccepted = false;
  const view = () => w.view('human');
  const record = (stage: string) => {
    const v = view(), helper = v.entities.find(e => e.id === 'person:helper')!;
    const water = v.map.waterVolumes.find(volume => helper.position.x > volume.min.x && helper.position.x < volume.max.x && helper.position.z > volume.min.z && helper.position.z < volume.max.z);
    return { stage, tick: v.tick, helperPosition: helper.position, helperVelocity: helper.velocity,
      waterId: water?.id ?? null, waterLevel: v.weather.waterLevel, grounded: w.state.characters.helper.grounded,
      truck: v.entities.find(e => e.id === 'truck')!.position, checkpoint: v.checkpoint,
      botPath: w.state.characters.helper.botMemory.path?.map(point => ({ ...point })) ?? [] };
  };
  const step = (n: number, input: Partial<TyagaInput> = {}) => {
    for (let i = 0; i < n; i++) {
      w.step({ human: { ...NEUTRAL_INPUT, ...input } });
      const started = w.state.events.findLast(e => e.id > lastRescueId && e.type === 'rescue-start' && e.participantId === 'helper');
      if (started) { lastRescueId = started.id; rescues.push({ event: started, ...record('rescue-start') }); }
    }
  };
  const action = (value: TyagaAction) => {
    const response = w.action('human', value).result;
    expect(response.ok, JSON.stringify({ action: value, response })).toBe(true);
  };
  try {
    const cab = w.socket('truck', 'cab-right')!.world, target = V(cab.x, 0, cab.z + .8);
    for (let frame = 0; frame < 600; frame++) {
      const p = w.body('person:human').translation(), dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz);
      if (d < .12) break;
      step(1, { moveX: dx / d * clamp(d / .5, 0, 1), moveZ: dz / d * clamp(d / .5, 0, 1) });
    }
    step(15); action({ type: 'operate', targetId: 'truck' }); action({ type: 'brake', enabled: false });
    let arrived = false;
    for (let frame = 0; frame < 800; frame++) {
      const v = view(), truck = v.entities.find(e => e.id === 'truck')!, remaining = 99.4 - truck.position.x;
      expect(v.phase, 'The real truck must survive the approach').toBe('running');
      if (remaining < .6 && Math.abs(v.truck.speed) < .2) { arrived = true; step(90, { brake: true }); break; }
      const heading = -Math.atan2(48 - truck.position.z, 6), error = angleDifference(heading, yaw(truck.rotation));
      const desired = Math.min(2, Math.max(0, remaining * .7)), brake = v.truck.speed > desired + .2 || remaining < .6;
      step(6, { throttle: brake ? 0 : clamp((desired - v.truck.speed) * 1.4 + .08, 0, 1), steer: clamp(error * 1.8, -1, 1), brake });
      if (frame % 10 === 0) trace.push(record('driving'));
    }
    expect(arrived, JSON.stringify(record('truck-did-not-arrive'))).toBe(true);
    action({ type: 'release' });
    for (let frame = 0; frame < 3600 && !view().checkpoint.ready; frame++) { step(1); if (frame % 60 === 0) trace.push(record('waiting-for-crew')); }
    expect(rescues, JSON.stringify({ rescueCount: rescues.length, final: record('final') })).toEqual([]);
    expect(view().checkpoint.ready, JSON.stringify(record('crew-missing'))).toBe(true);
    action({ type: 'checkpoint', checkpointId: 'quarry-cp1' }); checkpointAccepted = true;
  } finally {
    const result = { kind: 'Fresh map to CP1 through ordinary inputs/actions; no pose or state assignment; not browser acceptance', checkpointAccepted, rescues, final: record('final'), trace };
    console.log(JSON.stringify({ quarryBotNavigation: { checkpointAccepted, rescues, final: result.final } }));
    evidence('quarry-helper-water', result, result.kind); w.dispose();
  }
}, 120_000);
