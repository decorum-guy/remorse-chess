import { describe, expect, it } from 'vitest'
import { benchmarkCore } from './core-benchmark'

describe('maximum-scene core workload', () => {
  it('steps all 6 fighters / 6 builders / 12 drones / 2 transports / 30 buildings and six tools', () => {
    const reports = benchmarkCore(process.env.FORPOST_PERF === '1' ? 500 : 100)
    for (const report of reports) {
      console.info(JSON.stringify(report))
      expect(report).toMatchObject({ fighters: 6, builders: 6, drones: 12, buildings: 30, transports: 2, tools: 6, activeConstruction: 6, illegalUnits: [] })
      expect(Number.isFinite(report.p99ms)).toBe(true)
      expect(report.maxViewBytes).toBeLessThan(250000)
      if (process.env.FORPOST_PERF === '1') expect(report.p99ms).toBeLessThan(1000 / 30 / 2)
    }
  }, 60000)
})
