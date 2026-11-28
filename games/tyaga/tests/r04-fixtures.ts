import { expect } from 'vitest';
import { NEUTRAL_INPUT } from '../src/core/config';
import { conjugate, length, quatMul, rotate, V, yawQuat } from '../src/core/math';
import { TyagaWorld } from '../src/server-world/world';

export const participants = [
  { participantId: 'alice', displayName: 'Alice', seatIndex: 0, bot: false },
  { participantId: 'bob', displayName: 'Bob', seatIndex: 1, bot: false },
];
export function steps(w: TyagaWorld, count: number, tool = 0) {
  for (let i = 0; i < count; i++) w.step({ alice: { ...NEUTRAL_INPUT, tool } });
}

/** Initial test placement reproduces the public R04/025 transforms. These are
 * isolated regressions, not ordinary map or browser completion. After setup,
 * installation, attachment and winding use the same player actions/inputs. */
export async function observedWinchFixture(facingLoad = false) {
  const w = await TyagaWorld.create({ matchId: 'R04-tools', mapId: 'tutorial', participants });
  const positions = {
    'training-anchor': V(23.816770553588867, .42496904730796814, 14.367894172668457),
    'training-light': V(10.12781810760498, .149906188249588, 26.805940628051758),
    'person:alice': V(22.502307891845703, .8749657273292542, 15.099281311035156),
  };
  for (const [id, position] of Object.entries(positions)) {
    const body = w.body(id); body.setTranslation(position, true); body.setLinvel(V(), true); body.setAngvel(V(), true);
  }
  w.body('training-light').setRotation({ x: .9968453049659729, y: 4.948357279488391e-9, z: .07936977595090866, w: 4.70188972201413e-8 }, true);
  w.body('training-anchor').setRotation({ x: -1.9600307155087648e-7, y: .0015770148020237684, z: -5.545921766270112e-8, w: .9999988079071045 }, true);
  const winch = w.state.inventory['winch-1']; winch.state = 'world'; winch.bodyId = winch.id;
  w.addBody({ id: winch.id, kind: 'winch', position: V(22.397144317626953, .27491527795791626, 13.996566772460938), rotation: facingLoad ? yawQuat(-Math.atan2(26.95044491 - 13.99656677, 11.47188617 - 22.39714432)) : { x: -2.9185447392165997e-9, y: -.120490163564682, z: 2.361352358093427e-8, w: .9927145838737488 } });
  const strap = w.state.inventory['strap-11']; strap.state = 'world'; strap.bodyId = strap.id;
  w.addBody({ id: strap.id, kind: 'strap', position: V(21.338655471801758, .15, 15.601890563964844) });
  w.updateMasses(); steps(w, 30);
  expect(w.action('alice', { type: 'anchor', itemId: 'training-anchor' }).result.ok).toBe(true); steps(w, 185);
  return w;
}

export function attachBase(w: TyagaWorld, reverse = false) {
  const result = w.action('alice', { type: 'attach', kind: 'strap', fromId: reverse ? 'training-anchor' : 'winch-1', fromSocket: reverse ? 'ring' : 'base', toId: reverse ? 'winch-1' : 'training-anchor', toSocket: reverse ? 'base' : 'ring', itemId: 'strap-11' });
  if (result.result.ok) steps(w, 125);
  return result;
}
export const cableAction = { type: 'attach' as const, kind: 'rope' as const, fromId: 'winch-1', fromSocket: 'drum', toId: 'training-light', toSocket: 'ring-1-1' };

/** Read-only kinetic-energy measurement in each body's actual inertia frame. */
export function kineticState(w:TyagaWorld,ids:string[]){
  const bodies=ids.map(id=>{
    const body=w.body(id),inertia=body.principalInertia(),angular=rotate(conjugate(quatMul(body.rotation(),body.principalInertiaLocalFrame())),body.angvel());
    const linearEnergy=.5*body.mass()*length(body.linvel())**2,angularEnergy=.5*(inertia.x*angular.x**2+inertia.y*angular.y**2+inertia.z*angular.z**2);
    return{id,position:{...body.translation()},linearVelocity:{...body.linvel()},angularVelocity:{...body.angvel()},linearEnergy,angularEnergy};
  });
  return{bodies,energy:bodies.reduce((sum,b)=>sum+b.linearEnergy+b.angularEnergy,0)};
}
