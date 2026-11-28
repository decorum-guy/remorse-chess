/** Explicit load-test setup only. The product never imports this module.
 * Bodies are arranged once in a fresh isolated database. The unchanged compiled
 * runtime then restores them and receives ordinary authenticated WS commands. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { createTyagaAdapter, TyagaWorld } from '@iva-games/tyaga/server';
import { V, add, sub, Q, distance, quatAxis } from '../../../games/tyaga/src/core/math';
import { PHYSICS } from '../../../games/tyaga/src/core/config';
import type { StartMatchRequest } from '@iva-games/session-kit';
import { RealtimeEngine } from '../src/engine';
import { RealtimeStore, LocalStorageClient } from '../src/storage';
import { archiveCurrentArtifact } from '../src/artifacts';
import { archiveCurrentClient } from '../src/client-content';

type Scene = 'ferry' | 'lift' | 'paired';
function place(world: TyagaWorld, id: string, x: number, y: number, z: number): void {
  const body = world.body(id); body.setTranslation(V(x, y, z), true); body.setRotation(Q(), true);
  body.setLinvel(V(), true); body.setAngvel(V(), true);
}
function loadedTruck(world: TyagaWorld, x: number, y: number, z: number): void {
  const delta = sub(V(x, y, z), world.body('truck').translation());
  for (const id of ['truck', 'equipment-crate', 'cargo-1', 'cargo-2', 'cargo-3']) {
    const body = world.body(id); body.setTranslation(add(body.translation(), delta), true); body.setLinvel(V(), true); body.setAngvel(V(), true);
  }
  world.state.truck.grips = []; world.state.truck.brake = true;
}
export async function seedHeavyLoad(options: { runtime: string; clientDirectory: string; data: string; rooms: number; scene: Scene }) {
  const maps = options.scene === 'paired' ? ['quarry', 'ridge'] as const : options.scene === 'ferry' ? ['quarry'] as const : ['ridge'] as const;
  assert.equal(options.rooms, maps.length, 'One-room scenes require --rooms 1; paired requires --rooms 2');
  const databasePath = join(options.data, 'realtime.sqlite');
  assert.equal(existsSync(databasePath), false, 'Heavy setup requires a fresh owned database');
  const artifact = archiveCurrentArtifact(dirname(options.runtime), join(options.data, 'runtime-artifacts'));
  const adapter = createTyagaAdapter(), originalCreate = adapter.create.bind(adapter);
  adapter.runtimeArtifactId += ':' + artifact.sha256;
  const client = archiveCurrentClient(options.clientDirectory, join(options.data, 'client-artifacts'), {
    gameId: adapter.gameId, route: '/play/tyaga/', rulesVersion: adapter.rulesVersion, contentVersion: adapter.contentVersion,
  });
  const evidence: unknown[] = [];
  adapter.create = async input => {
    const world = await originalCreate(input);
    try {
      const inventoryBefore = JSON.stringify(world.state.inventory);
      const payloadIds = ['truck', 'equipment-crate', 'cargo-1', 'cargo-2', 'cargo-3', ...input.participants.map(p => `person:${p.participantId}`)];
      const extras: { id: string; purpose: string }[] = [];
      if (world.map.id === 'quarry') {
        const ferry = world.state.machinery.ferry!;
        for (const handle of ferry.supportHandles) { const body = world.physics.getRigidBody(handle); if (body) world.physics.removeRigidBody(body); }
        ferry.supportHandles = []; ferry.launched = true;
        place(world, 'ferry-deck', 58, -2.4, 64); place(world, 'pontoon-left', 58, -2.825, 62.3); place(world, 'pontoon-right', 58, -2.825, 65.7);
        for (const x of [-1, 1]) for (const z of [-1, 1]) world.addLink('ferry-lock', 'ferry-deck', `lock-${x}-${z}`, z === -1 ? 'pontoon-left' : 'pontoon-right', x === -1 ? 'lock-rear' : 'lock-front');
        place(world, 'ferry-drive', 53.25, -3, 66); world.addLink('ferry-lock', 'ferry-deck', 'drive', 'ferry-drive', 'drive'); ferry.driveId = 'ferry-drive';
        loadedTruck(world, 58, -1.25, 64);
        for (const [index, participant] of input.participants.entries()) place(world, `person:${participant.participantId}`, 58 + [-2.8, 0, 2.8][Math.floor(index / 2)], -1.4, 64 + (index % 2 ? 1.7 : -1.7));
        for (const [index, x, z, socket] of [[0, 39, 54, 'ring-rear'], [1, 79, 70, 'ring-front']] as const) {
          const id = `load-only-mooring-${index}`;
          // The drum faces the target. In particular the far support must not
          // send its initial cable backwards through its own winch housing.
          world.addBody({ id, kind: 'winch', position: V(x, -2, z), rotation: index ? quatAxis(V(0, 1, 0), Math.PI) : Q(), fixed: true });
          const source = world.socket(id, 'drum')!, target = world.socket('ferry-deck', socket)!;
          assert.ok(distance(source.world, target.world) <= PHYSICS.ropeMax, 'Mooring endpoints exceed the actual cable limit');
          world.addLink('rope', id, 'drum', 'ferry-deck', socket);
          extras.push({ id, purpose: 'Artificial fixed mooring support; not supplied by the normal inventory. Physical cables restrain the vessel without assigning its pose during measurement.' });
        }
      } else {
        const lift = world.state.machinery.lift!;
        place(world, 'lift-drive', 221.45, 16.7, 69.3); world.addLink('ferry-lock', 'lift-transmission', 'drive', 'lift-drive', 'drive'); lift.driveId = 'lift-drive';
        for (const id of Object.keys(lift.barriers)) { lift.barriers[id] = true; for (const handle of world.state.entities[id].colliders) world.physics.getCollider(handle).setCollisionGroups(0xffffffff); }
        loadedTruck(world, 222, 11.2, 72);
        for (const [index, participant] of input.participants.entries()) place(world, `person:${participant.participantId}`, 222 + [-2.8, 0, 2.8][Math.floor(index / 2)], 11.08, 72 + (index % 2 ? 1.7 : -1.7));
        // Down-facing overhead drums keep the initial cable outside their
        // housings. Ordinary 24kg beams provide load without the destructive
        // 3000kg mass of the separate overload test. Neither hanging fixture
        // contributes to the lift's original manifest mass.
        for (const [index, x] of [18, 26].entries()) {
          const winch = `load-only-winch-${index}`, beam = `load-only-hanging-beam-${index}`;
          world.addBody({ id: winch, kind: 'winch', position: V(x, 30, 6), rotation: quatAxis(V(0, 0, 1), -Math.PI / 2), fixed: true });
          world.addBody({ id: beam, kind: 'beam', position: V(x + 1.45, 11.67, 6.07) });
          assert.ok(distance(world.socket(winch, 'drum')!.world, world.socket(beam, 'ring--1--1')!.world) <= PHYSICS.ropeMax);
          world.addLink('rope', winch, 'drum', beam, 'ring--1--1');
          extras.push({ id: winch, purpose: 'Artificial fixed overhead support outside the playable lift assembly.' },
            { id: beam, purpose: 'Additional physical 24kg suspended cable load, not an unpacked inventory item or lift payload.' });
        }
      }
      assert.equal(JSON.stringify(world.state.inventory), inventoryBefore, 'Original stock must remain unchanged');
      const ropes = Object.values(world.state.links).filter(link => link.kind === 'rope');
      assert.equal(ropes.length, 2); assert.equal(ropes.reduce((sum, rope) => sum + (rope.segments?.length ?? 0), 0), 48);
      assert.ok(ropes.every(rope => rope.length <= PHYSICS.ropeMax && !rope.broken));
      const cargoAndCrewMass = payloadIds.reduce((sum, id) => sum + world.body(id).mass(), 0);
      assert.ok(Math.abs(cargoAndCrewMass - (world.map.id === 'quarry' ? 3059 : 3417)) < .1, 'Loaded manifest/crew mass differs from the recorded physical fixture');
      const machineryIds = world.map.id === 'quarry' ? ['ferry-deck', 'pontoon-left', 'pontoon-right', 'ferry-drive'] : ['lift-platform', 'lift-barrier-near', 'lift-barrier-far'];
      const assemblyMass = cargoAndCrewMass + machineryIds.reduce((sum, id) => sum + world.body(id).mass(), 0);
      assert.ok(Math.abs(assemblyMass - (world.map.id === 'quarry' ? 3779 : 3937)) < .1, 'Loaded assembly mass differs from the recorded physical fixture');
      evidence.push({ mapId: world.map.id, fixtureOnly: true, normalInventoryUnchanged: true, cargoAndCrewMass,
        assemblyMass, expectedAssemblyMass: world.map.id === 'quarry' ? 3779 : 3937, expectedPayloadKg: world.map.id === 'quarry' ? 3059 : 3417,
        machineryCapacityKg: world.map.id === 'quarry' ? 3500 : 3800, players: input.participants.length,
        rigidBodies: world.physics.bodies.len(), colliders: world.physics.colliders.len(), impulseJoints: world.physics.impulseJoints.len(),
        ropeLinks: ropes.length, contactSegments: 48, collars: ropes.filter(rope => rope.collarId).length, hooks: ropes.filter(rope => rope.hookId).length,
        cableLimitMetres: PHYSICS.ropeMax, contactSegmentLengthLimitMetres: PHYSICS.ropeSegment,
        solverNote: 'rope64 in the solver version means additional solver iterations; it is not a cable or segment-count budget.',
        ropes: ropes.map(rope => ({ id: rope.id, from: rope.fromId, to: rope.toId, length: rope.length,
          contactSegments: rope.segments?.length, fromWorld: world.socket(rope.fromId, rope.fromSocket)!.world, toWorld: world.socket(rope.toId, rope.toSocket)!.world })),
        stressOnlyExtras: extras, legalGameplayClaim: false,
        limitation: 'The normal loaded assembly is copied from physical fixtures. Stress supports and extra hanging loads are explicit test additions. Stability, load retention and throughput still require an actual run.' });
      return world;
    } catch (error) { world.dispose(); throw error; }
  };
  const store = new RealtimeStore(databasePath), engine = new RealtimeEngine({ storage: new LocalStorageClient(store), adapters: [adapter], maxMatches: options.rooms });
  const starts: { matchId: string; input: StartMatchRequest }[] = [];
  try {
    await engine.initialize();
    for (const [room, mapId] of maps.entries()) {
      const participants = Array.from({ length: 6 }, (_value, seatIndex) => ({ participantId: `load-${room}-${seatIndex}`, playerId: `load-player-${room}-${seatIndex}`,
        displayName: `Heavy fixture ${seatIndex + 1}`, seatIndex, controller: { kind: 'human' as const, playerId: `load-player-${room}-${seatIndex}` } }));
      const input: StartMatchRequest = { startCommandId: randomUUID(), roomId: randomUUID(), hostPlayerId: participants[0].playerId,
        rulesVersion: adapter.rulesVersion, contentVersion: adapter.contentVersion, settings: { mapId, mode: 'practice' }, participants };
      const created = await engine.create(adapter.gameId, input, { clientContentHash: client.sha256, clientRoute: client.route }); starts.push({ ...created, input });
    }
    await engine.drain();
    const manifest = { gameId: adapter.gameId, rulesVersion: adapter.rulesVersion, contentVersion: adapter.contentVersion, physicsBuildHash: adapter.physicsBuildHash, runtimeArtifactId: adapter.runtimeArtifactId };
    const result = { fixtureOnly: true, scene: options.scene, artifact: artifact.sha256, client: client.sha256, manifest, evidence, starts };
    writeFileSync(join(options.data, 'heavy-fixture.json'), JSON.stringify(result, null, 2)); return result;
  } finally { await engine.drain(); store.close(); }
}
