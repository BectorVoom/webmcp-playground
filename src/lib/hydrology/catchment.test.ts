import { describe, expect, it } from 'vitest'
import {
  arealReductionFactor,
  deliverableInflow,
  gumbelReturnLevel,
  meanAnnualFloodM3PerS,
  mainChannelLengthKm,
  timeOfConcentrationHours,
  triangularPeakM3PerS,
} from './catchment'

describe("Hack's law channel length", () => {
  it('follows L = 1.4·A^0.6', () => {
    expect(mainChannelLengthKm(1)).toBeCloseTo(1.4, 6)
    expect(mainChannelLengthKm(1000)).toBeCloseTo(88.3, 1)
  })
})

describe('Kirpich time of concentration', () => {
  it('grows with length and falls with slope', () => {
    const short = timeOfConcentrationHours(10, 0.01)
    const long = timeOfConcentrationHours(100, 0.01)
    const steep = timeOfConcentrationHours(100, 0.05)
    expect(long).toBeGreaterThan(short)
    expect(steep).toBeLessThan(long)
  })

  it('puts a 1000 km² basin in the right order of magnitude', () => {
    // ~88 km of channel at a 1% slope: half a day, not minutes and not a week.
    const tc = timeOfConcentrationHours(mainChannelLengthKm(1000), 0.01)
    expect(tc).toBeGreaterThan(6)
    expect(tc).toBeLessThan(24)
  })
})

describe('SCS triangular unit hydrograph', () => {
  it('follows Qp = 0.208·A·Q/Tp', () => {
    expect(triangularPeakM3PerS(1000, 235, 19.4)).toBeCloseTo(2519.59, 1)
  })

  it('returns zero rather than dividing by zero', () => {
    expect(triangularPeakM3PerS(100, 50, 0)).toBe(0)
  })
})

describe('deliverable inflow from an upstream catchment', () => {
  it('delivers essentially everything from a small catchment over a long storm', () => {
    const d = deliverableInflow(20, 200, 48, 0.01)
    expect(d.attenuation).toBeCloseTo(1, 2)
    expect(d.volumeM3).toBeCloseTo(d.generatedM3, 0)
  })

  it('withholds most of a large catchment over a short storm', () => {
    // A 3000 km² basin cannot deliver a day of rain to one point in 3 hours.
    const d = deliverableInflow(3000, 200, 3, 0.005)
    expect(d.attenuation).toBeLessThan(0.35)
    expect(d.volumeM3).toBeLessThan(d.generatedM3)
    expect(d.timeOfConcentrationHours).toBeGreaterThan(12)
  })

  it('never delivers more than the catchment generates', () => {
    for (const [areaKm2, durationHours] of [[1, 72], [50, 48], [500, 24], [5000, 1]] as const) {
      const d = deliverableInflow(areaKm2, 300, durationHours, 0.01)
      expect(d.volumeM3).toBeLessThanOrEqual(d.generatedM3 + 1e-6)
      expect(d.attenuation).toBeLessThanOrEqual(1 + 1e-9)
      expect(d.attenuation).toBeGreaterThan(0)
    }
  })

  it('gives a plausible peak for a real basin: Kuzuryu-scale, 235 mm in 24 h', () => {
    const d = deliverableInflow(1000, 235, 24, 0.01)
    // The Asuwa/Kuzuryu design discharges at Fukui are thousands of m3/s, not
    // hundreds and not tens of thousands.
    expect(d.peakDischargeM3PerS).toBeGreaterThan(1000)
    expect(d.peakDischargeM3PerS).toBeLessThan(6000)
  })
})

describe('Gumbel return levels', () => {
  // mean 100, s = 39.5285 -> beta 30.822, mu 82.210
  const series = [50, 75, 100, 125, 150]

  it('matches a hand-worked method-of-moments fit', () => {
    expect(gumbelReturnLevel(series, 2)).toBeCloseTo(93.51, 1)
    expect(gumbelReturnLevel(series, 100)).toBeCloseTo(224.0, 0)
  })

  it('rises with return period', () => {
    let previous = 0
    for (const T of [2, 5, 10, 50, 100]) {
      const level = gumbelReturnLevel(series, T)
      expect(level).toBeGreaterThan(previous)
      previous = level
    }
  })

  it('refuses a series too short to fit, and a return period of one', () => {
    expect(() => gumbelReturnLevel([10, 20, 30], 2)).toThrow(/at least 5/)
    expect(() => gumbelReturnLevel(series, 1)).toThrow(/returnPeriodYears/)
  })
})

describe('areal reduction factor', () => {
  it('matches the worked values for a 24 h storm', () => {
    // Leclerc & Schaake as used in NWS TP-29, evaluated by hand:
    // decay = 1.1*24^0.25 = 2.4347, exp(-decay) = 0.08765.
    expect(arealReductionFactor(24, 10)).toBeCloseTo(0.997, 3)
    expect(arealReductionFactor(24, 1000)).toBeCloseTo(0.914, 3)
    // The plan's third worked value (0.89) is below the formula's own floor:
    // for any area the factor flattens at 1 - exp(-1.1*D^0.25) = 0.912 at 24 h.
    expect(arealReductionFactor(24, 5000)).toBeCloseTo(0.912, 3)
  })

  it('leaves a point storm over a point catchment alone, and never exceeds one', () => {
    expect(arealReductionFactor(24, 0)).toBe(1)
    expect(arealReductionFactor(0, 500)).toBe(1)
    for (const areaKm2 of [1, 10, 100, 1000, 10_000]) {
      for (const durationHours of [1, 6, 12, 24, 72]) {
        const arf = arealReductionFactor(durationHours, areaKm2)
        expect(arf).toBeGreaterThan(0)
        expect(arf).toBeLessThanOrEqual(1)
      }
    }
  })

  it('reduces more as the catchment grows and less as the storm lengthens', () => {
    expect(arealReductionFactor(24, 2000)).toBeLessThan(arealReductionFactor(24, 200))
    expect(arealReductionFactor(72, 1000)).toBeGreaterThan(arealReductionFactor(6, 1000))
  })
})

describe('mean annual flood', () => {
  it('lands in the right band for a Kinugawa-scale basin', () => {
    // 1 760 km², 2-year daily rainfall 75 mm (ERA5 at Joso), CN 80.
    const q = meanAnnualFloodM3PerS(1760, 75.2, 80, 0.0124)
    expect(q).toBeGreaterThan(200)
    expect(q).toBeLessThan(1500)
  })

  it('grows with catchment area and with rainfall', () => {
    const base = meanAnnualFloodM3PerS(500, 80, 80, 0.01)
    expect(meanAnnualFloodM3PerS(2000, 80, 80, 0.01)).toBeGreaterThan(base)
    expect(meanAnnualFloodM3PerS(500, 140, 80, 0.01)).toBeGreaterThan(base)
  })

  it('is zero where the rain never exceeds the initial abstraction', () => {
    expect(meanAnnualFloodM3PerS(500, 5, 80, 0.01)).toBe(0)
    expect(meanAnnualFloodM3PerS(0, 100, 80, 0.01)).toBe(0)
  })

  it('falls when the point rainfall is areally reduced, and by more on a bigger basin', () => {
    const point = meanAnnualFloodM3PerS(1000, 100, 80, 0.01)
    const areal = meanAnnualFloodM3PerS(1000, 100, 80, 0.01, { arealReduction: true })
    expect(areal).toBeLessThan(point)
    // ~9% less rain through SCS-CN is a larger relative loss in runoff.
    expect(areal / point).toBeGreaterThan(0.8)
    expect(areal / point).toBeLessThan(0.95)

    const smallLoss = 1 - meanAnnualFloodM3PerS(10, 100, 80, 0.01, { arealReduction: true })
      / meanAnnualFloodM3PerS(10, 100, 80, 0.01)
    const largeLoss = 1 - areal / point
    expect(smallLoss).toBeLessThan(largeLoss)
  })
})
