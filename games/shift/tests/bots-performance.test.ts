import { expect, it } from 'vitest';
import { createMatch } from '../src/core';
import { advanceWithBots } from '../src/bots';
import type { ArenaId, Seat } from '../src/core';
it('runs six concurrent 3v3 bot matches under the 25ms p95 combined-tick budget', () => {
  const seats: Seat[] = (['teal', 'amber'] as const).flatMap(team => [0, 1, 2].map(teamIndex => ({ seatId: `${team}${teamIndex}`, displayName: 'Pilot', team, teamIndex, initialRole: teamIndex === 0 ? 'navigator' : 'pilot', bot: true })));
  const states = Array.from({ length: 6 }, (_, i) => createMatch({ arena: (['foundry', 'calibration', 'depot'] as ArenaId[])[i % 3], teamSize: 3 }, seats, 81 + i));
  const samples: number[] = [];
  for (let tick = 0; tick < 18000 && states.some(s => s.phase !== 'finished'); tick++) {
    const activeCount = states.filter(s => s.phase === 'active').length, before = performance.now();
    for (const state of states) if (state.phase !== 'finished') advanceWithBots(state);
    if (activeCount >= 4) samples.push(performance.now() - before);
  }
  samples.sort((a, b) => a - b); const p95 = samples[Math.floor(samples.length * .95)];
  expect(states.every(s => s.phase === 'finished')).toBe(true); expect(samples.length).toBeGreaterThan(300); expect(p95).toBeLessThan(25);
  console.log(JSON.stringify({ sixConcurrent3v3: { samples: samples.length, p95Ms: p95, maxMs: samples.at(-1), over33ms: samples.filter(t => t > 1000 / 30).length, results: states.map(s => ({ arena: s.settings.arena, tick: s.tick, score: s.score, deliveries: s.rounds.filter(r => r.reason === 'delivery').length })) } }));
}, 60000);
