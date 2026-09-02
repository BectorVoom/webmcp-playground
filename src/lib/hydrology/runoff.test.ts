import { describe, expect, it } from 'vitest'
import { estimateRunoff } from './runoff'

describe('SCS Curve Number runoff (TR-55 eq. 2-3/2-4)', () => {
  it('reproduces the textbook value for 100 mm on CN 80', () => {
    const q = estimateRunoff(100, 80)
    // S = 25400/80 − 254 = 63.5 mm, Ia = 12.7 mm, Q = 87.3²/150.8 = 50.54 mm
    expect(q.potentialRetentionMm).toBeCloseTo(63.5, 5)
    expect(q.initialAbstractionMm).toBeCloseTo(12.7, 5)
    expect(q.runoffMm).toBeCloseTo(50.539, 2)
  })

  it('produces no runoff until rainfall exceeds the initial abstraction', () => {
    expect(estimateRunoff(12.7, 80).runoffMm).toBe(0)
    expect(estimateRunoff(5, 80).runoffMm).toBe(0)
    expect(estimateRunoff(0, 80).runoffMm).toBe(0)
  })

  it('converts all rainfall to runoff on an impervious surface (CN 100)', () => {
    const q = estimateRunoff(42, 100)
    expect(q.potentialRetentionMm).toBe(0)
    expect(q.runoffMm).toBeCloseTo(42, 6)
  })

  it('never yields more runoff than rainfall, and runoff grows with rainfall', () => {
    let previous = 0
    for (const p of [10, 25, 50, 100, 200, 500]) {
      const q = estimateRunoff(p, 75).runoffMm
      expect(q).toBeLessThanOrEqual(p)
      expect(q).toBeGreaterThanOrEqual(previous)
      previous = q
    }
  })

  it('rejects out-of-range inputs with the offending value named', () => {
    expect(() => estimateRunoff(-1, 80)).toThrow(/rainfallMm/)
    expect(() => estimateRunoff(Number.NaN, 80)).toThrow(/rainfallMm/)
    expect(() => estimateRunoff(100, 20)).toThrow(/curveNumber/)
    expect(() => estimateRunoff(100, 101)).toThrow(/curveNumber/)
  })
})
