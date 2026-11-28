import { describe, expect, it } from 'vitest'
import { createWorld, setController, stepWorld } from '../src/core/index'
import type { MapId, Team } from '../src/core/types'

describe('Forpost technical bot games', () => {
  it('completes an actual full seeded match through the same core without assigning an outcome', () => {
    const w = createWorld({ matchId: 'bot-smoke', mapId: 'FP01', seed: 1201, firstSide: 'L', teamSize: 1, participants: [
      { id: 'A1', name: 'Technical human controller', team: 'A', controller: 'human' }, { id: 'B1', name: 'Bot', team: 'B', controller: 'bot', botLevel: 'normal' },
    ] })
    setController(w, 'A1', 'bot')
    const start = performance.now()
    while (w.phase !== 'finished' && w.tick <= 36100) stepWorld(w)
    console.info(JSON.stringify({ scenario: 'bot-smoke', elapsedMs: Math.round(performance.now() - start), ticks: w.tick, operations: w.operations, spent: w.participants.map(p => p.statistics.spent), errors: w.technicalErrors }))
    expect(w.phase).toBe('finished'); expect(w.technicalErrors).toEqual([]); expect(w.participants.some(p => p.statistics.spent > 180)).toBe(true)
  }, 180000)

  it.skipIf(process.env.FORPOST_SERIES !== '1')('finishes the requested 3 maps × 3 sizes × 2 sides × 4 seeds = 72 matches', () => {
    const results: unknown[] = []
    for (const mapId of ['FP01', 'FP02', 'FP03'] as MapId[]) for (const teamSize of [1, 2, 3] as const) for (const firstSide of ['L', 'R'] as const) for (const seed of [1201, 1202, 1203, 1204]) {
      const participants = (['A', 'B'] as Team[]).flatMap(team => Array.from({ length: teamSize }, (_, i) => ({ id: `${team}${i + 1}`, name: `${team} bot ${i + 1}`, team, controller: team === 'A' && i === 0 ? 'human' as const : 'bot' as const, botLevel: 'normal' as const })))
      const w = createWorld({ matchId: `series-${mapId}-${teamSize}-${firstSide}-${seed}`, mapId, teamSize, firstSide, seed, idSalt: `technical-series-${seed}`, participants })
      setController(w, 'A1', 'bot')
      const start = performance.now(), stepTimes: number[] = []
      while (w.phase !== 'finished' && w.tick <= 36100) { const before = performance.now(); stepWorld(w); stepTimes.push(performance.now() - before) }
      const wallMs = Math.round(performance.now() - start); stepTimes.sort((a, b) => a - b)
      const row = { mapId, teamSize, firstSide, seed, ticks: w.tick, wallMs, p99StepMs: stepTimes[Math.ceil(stepTimes.length * 0.99) - 1], maxStepMs: stepTimes.at(-1), phase: w.phase, winner: w.winner, operations: w.operations, expenses: w.participants.map(p => p.statistics.spent), income: w.participants.map(p => Math.round(p.statistics.income * 100) / 100), tacticsTicks: w.participants.map(p => p.statistics.tacticsTicks), technicalErrors: w.technicalErrors }
      results.push(row); console.info(JSON.stringify(row))
      expect(w.phase).toBe('finished'); expect(w.technicalErrors).toEqual([]); expect(w.participants.every(p => p.credits >= 0 && p.credits <= 600)).toBe(true)
    }
    expect(results).toHaveLength(72)
  }, 7200000)
})
