import { describe, expect, it } from 'vitest'
import {
  assessOvertopping,
  bankfullDepthFromDischarge,
  bankfullWidthFromDischarge,
  bankfullDepthMetres,
  bankfullWidthMetres,
  channelGeometry,
  conveyanceVolumeM3,
  manningDischargeM3PerS,
} from './channel'

describe('downstream hydraulic geometry (Bieger et al. 2015)', () => {
  it('reproduces the published power laws', () => {
    // W = 2.70·A^0.352, D = 0.30·A^0.213, A in km².
    expect(bankfullWidthMetres(100)).toBeCloseTo(13.66, 2)
    expect(bankfullDepthMetres(100)).toBeCloseTo(0.8, 2)
    expect(bankfullWidthMetres(1)).toBeCloseTo(2.7, 6)
    expect(bankfullDepthMetres(1)).toBeCloseTo(0.3, 6)
  })

  it('grows monotonically with catchment area', () => {
    let w = 0
    let d = 0
    for (const a of [1, 10, 100, 1000, 5000]) {
      expect(bankfullWidthMetres(a)).toBeGreaterThan(w)
      expect(bankfullDepthMetres(a)).toBeGreaterThan(d)
      w = bankfullWidthMetres(a)
      d = bankfullDepthMetres(a)
    }
  })
})

describe("Manning's equation", () => {
  it('matches a hand-worked rectangular channel', () => {
    // W=10 m, D=2 m, S=0.001, n=0.035: A=20, P=14, R=1.4286, Q=22.9 m³/s.
    expect(manningDischargeM3PerS(10, 2, 0.001, 0.035)).toBeCloseTo(22.9, 1)
  })

  it('scales with the square root of slope', () => {
    const gentle = manningDischargeM3PerS(10, 2, 0.001, 0.035)
    const steep = manningDischargeM3PerS(10, 2, 0.004, 0.035)
    expect(steep / gentle).toBeCloseTo(2, 3)
  })

  it('returns zero rather than NaN for degenerate geometry', () => {
    expect(manningDischargeM3PerS(0, 2, 0.001, 0.035)).toBe(0)
    expect(manningDischargeM3PerS(10, 2, 0, 0.035)).toBe(0)
    expect(manningDischargeM3PerS(10, -1, 0.001, 0.035)).toBe(0)
  })
})

describe('per-cell channel capacity', () => {
  it('gives capacity to channel cells only', () => {
    const areas = Float64Array.from([1e8, 1e8, 1e5])
    const slope = Float64Array.from([0.001, 0.001, 0.001])
    const isChannel = Uint8Array.from([1, 0, 0])
    const g = channelGeometry(areas, slope, isChannel)

    expect(g.capacityM3PerS[0]).toBeGreaterThan(0)
    expect(g.widthM[0]).toBeCloseTo(bankfullWidthMetres(100), 6)
    expect(g.capacityM3PerS[1]).toBe(0)
    expect(g.widthM[2]).toBe(0)
  })

  it('converts capacity to an event volume', () => {
    const v = conveyanceVolumeM3(Float64Array.from([10, 0]), 3600)
    expect(v[0]).toBe(36000)
    expect(v[1]).toBe(0)
  })
})

describe('overtopping assessment', () => {
  const durationSeconds = 1000

  it('flags reaches whose routed discharge exceeds bankfull capacity', () => {
    //           cell 0: not a channel      1: within capacity     2: 3x over
    const routed = Float64Array.from([99999, 5000, 30000])
    const capacity = Float64Array.from([0, 10, 10])
    const isChannel = Uint8Array.from([0, 1, 1])

    const r = assessOvertopping(routed, capacity, isChannel, durationSeconds)
    expect(r.channelCells).toBe(2)
    expect(r.overtoppingCells).toBe(1)
    expect(r.ratio[1]).toBeCloseTo(0.5, 6)
    expect(r.ratio[2]).toBeCloseTo(3, 6)
    expect(r.maxRatioCell).toBe(2)
    expect(r.peakDischargeM3PerS).toBeCloseTo(30, 6)
    expect(r.ratio[0]).toBe(0)
  })

  it('breaks ratio ties toward the larger river', () => {
    // Both 2x over capacity; the one that matters is the one carrying more.
    const routed = Float64Array.from([2000, 200000])
    const capacity = Float64Array.from([1, 100])
    const isChannel = Uint8Array.from([1, 1])
    const r = assessOvertopping(routed, capacity, isChannel, durationSeconds)
    expect(r.ratio[0]).toBeCloseTo(2, 6)
    expect(r.ratio[1]).toBeCloseTo(2, 6)
    expect(r.maxRatioCell).toBe(1)
  })
})

describe('discharge-keyed hydraulic geometry (Moody & Troutman 2002)', () => {
  it('reproduces W = 7.2·Q^0.50 and D = 0.27·Q^0.30', () => {
    expect(bankfullWidthFromDischarge(1)).toBeCloseTo(7.2, 6)
    expect(bankfullDepthFromDischarge(1)).toBeCloseTo(0.27, 6)
    expect(bankfullWidthFromDischarge(100)).toBeCloseTo(72, 4)
    expect(bankfullDepthFromDischarge(100)).toBeCloseTo(1.075, 3)
  })

  it('implies a plausible velocity across five orders of magnitude', () => {
    // The relations are only self-consistent if Q/(W·D) stays river-like.
    for (const q of [1, 10, 100, 1000, 10_000]) {
      const velocity = q / (bankfullWidthFromDischarge(q) * bankfullDepthFromDischarge(q))
      expect(velocity).toBeGreaterThan(0.4)
      expect(velocity).toBeLessThan(4)
    }
  })

  it('sizes a large river far above what the area-keyed relations do', () => {
    // The defect this replaced: a ~1 000 km² river came out under 2 m deep and
    // its Manning capacity two to four orders below its real flow.
    const areaKeyed = bankfullDepthMetres(1000)
    const dischargeKeyed = bankfullDepthFromDischarge(500)
    expect(areaKeyed).toBeLessThan(2.2)
    expect(dischargeKeyed).toBeGreaterThan(areaKeyed)
  })
})

describe('channel capacity from a supplied bankfull discharge', () => {
  it('takes the discharge as the capacity, and sizes the section from it', () => {
    const areas = Float64Array.from([1e9, 1e9])
    const slope = Float64Array.from([0.0001, 0.0001])
    const isChannel = Uint8Array.from([1, 1])
    const bankfull = Float64Array.from([500, 0])

    const g = channelGeometry(areas, slope, isChannel, 0.035, bankfull)
    // Cell 0 has a climate-derived discharge: capacity is exactly it.
    expect(g.capacityM3PerS[0]).toBe(500)
    expect(g.widthM[0]).toBeCloseTo(bankfullWidthFromDischarge(500), 6)
    expect(g.depthM[0]).toBeCloseTo(bankfullDepthFromDischarge(500), 6)
    // Cell 1 has none, so it falls back to the area-keyed route.
    expect(g.capacityM3PerS[1]).toBeGreaterThan(0)
    expect(g.capacityM3PerS[1]).not.toBe(500)
    expect(g.widthM[1]).toBeCloseTo(bankfullWidthMetres(1000), 6)
  })

  it('does not depend on slope when the discharge is supplied', () => {
    const areas = Float64Array.from([1e9])
    const isChannel = Uint8Array.from([1])
    const bankfull = Float64Array.from([500])
    const gentle = channelGeometry(areas, Float64Array.from([1e-4]), isChannel, 0.035, bankfull)
    const steep = channelGeometry(areas, Float64Array.from([1e-2]), isChannel, 0.035, bankfull)
    expect(gentle.capacityM3PerS[0]).toBe(steep.capacityM3PerS[0])
  })
})
