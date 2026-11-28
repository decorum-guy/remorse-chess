import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { applyAction, createWorld, deserializeWorld, resetInputStream, serializeWorld, setController, setRewindEstimate, stepWorld, viewForPlayer } from '@iva-games/forpost/core';
import type { CreateWorldOptions, Input, World } from '@iva-games/forpost/core';
const worlds = new Map<string, World>();
const controllerStates = new Map<string, Map<string, { generation: number; bot: boolean }>>();
function result(world: World) {
  return { world: serializeWorld(world), tick: world.tick, phase: world.phase,
    outcome: world.phase === 'finished' ? { winner: world.winner, resultId: world.resultId, operations: world.operations } : null,
    views: Object.fromEntries(world.participants.filter(p => p.controller === 'human').map(p => [p.id, viewForPlayer(world, p.id)])) };
}
parentPort!.on('message', (message: {id: number; op: string; args: unknown[]}) => {
  const started = performance.now(), cpu = process.threadCpuUsage();
  try {
    const args = message.args; let value: unknown;
    if (message.op === 'create') {
      const world = createWorld(args[0] as CreateWorldOptions); worlds.set(world.matchId, world); controllerStates.set(world.matchId, new Map()); value = result(world);
    } else if (message.op === 'load') {
      const world = deserializeWorld(args[0] as string); worlds.set(world.matchId, world); controllerStates.set(world.matchId, new Map()); value = result(world);
    } else if (message.op === 'drop') { worlds.delete(args[0] as string); controllerStates.delete(args[0] as string); value = null;
    } else {
      const world = worlds.get(args[0] as string); if (!world) throw new Error('MATCH_UNAVAILABLE');
      if (message.op === 'step') {
        const controls = args[3] as {id: string; bot: boolean; generation: number; rttMs: number}[];
        const previous = controllerStates.get(world.matchId)!;
        for (const control of controls) {
          const old = previous.get(control.id);
          if (!old || old.bot !== control.bot) setController(world, control.id, control.bot ? 'bot' : 'human');
          if (!old || old.generation !== control.generation) resetInputStream(world, control.id);
          previous.set(control.id, { generation: control.generation, bot: control.bot });
          setRewindEstimate(world, control.id, control.rttMs);
        }
        const actions = args[2] as {participantId: string; actionId: string; payload: Record<string, unknown>}[];
        const results = actions.map(a => ({ actionId: a.actionId, participantId: a.participantId, result: applyAction(world, a.participantId, { ...a.payload, actionId: a.actionId }) }));
        if (args[4] !== false) stepWorld(world, args[1] as Record<string, Input>);
        value = { ...result(world), results };
      } else if (message.op === 'view') value = result(world);
      else throw new Error('UNKNOWN_SIMULATION_OPERATION');
    }
    if (message.op === 'step') {
      const consumed = process.threadCpuUsage(cpu);
      value = { ...(value as object), workMs: performance.now() - started, workCpuMs: (consumed.user + consumed.system) / 1000 };
    }
    parentPort!.postMessage({ id: message.id, value });
  } catch (error) { parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : 'SIMULATION_FAILED' }); }
});
