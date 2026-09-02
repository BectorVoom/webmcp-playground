import { describe, expect, it } from 'vitest'
import {
  applyHydraulicStageEffects,
  estimateFloodWave,
  triangularPeakFromVolumeM3PerS,
} from './dynamics'

describe('timed flood-wave routing', () => {
  it('preserves the triangular hydrograph volume relation', () => {
    const peak = triangularPeakFromVolumeM3PerS(1_335 * 3600, 1)
    expect(peak).toBeCloseTo(1_000, 8)
    expect(triangularPeakFromVolumeM3PerS(0, 1)).toBe(0)
  })

  it('turns event volume into a finite peak and arrival instead of an event average', () => {
    const result = estimateFloodWave({
      routedVolumeM3: Float64Array.from([360_000, 720_000, 123]),
      drainageAreaM2: Float64Array.from([10e6, 30e6, 1]),
      elevations: Float32Array.from([90, 80, 0]),
      headwaterElevationM: Float64Array.from([100, 110, 0]),
      isChannel: Uint8Array.from([1, 1, 0]),
      channelWidthM: Float64Array.from([10, 20, 0]),
      channelDepthM: Float64Array.from([2, 3, 0]),
      channelCapacityM3PerS: Float64Array.from([50, 100, 0]),
      durationHours: 10,
    })

    expect(result.summary.channelCells).toBe(2)
    expect(result.peakDischargeM3PerS[0]).toBeGreaterThanOrEqual(10) // event average
    expect(result.arrivalTimeHours[0]).toBeGreaterThan(0)
    expect(result.peakTimeHours[0]).toBeGreaterThan(5) // rainfall centroid plus lag
    expect(result.characteristicSpeedMPerS[0]).toBeGreaterThan(0)
    expect(result.peakDischargeM3PerS[2]).toBe(0)
    expect(result.summary.trunkPeakTimeHours).toBe(result.peakTimeHours[1])
  })

  it('refuses mismatched grids before producing plausible-looking timing', () => {
    expect(() =>
      estimateFloodWave({
        routedVolumeM3: new Float64Array(2),
        drainageAreaM2: new Float64Array(1),
        elevations: new Float32Array(2),
        headwaterElevationM: new Float64Array(2),
        isChannel: new Uint8Array(2),
        channelWidthM: new Float64Array(2),
        channelDepthM: new Float64Array(2),
        channelCapacityM3PerS: new Float64Array(2),
        durationHours: 1,
      }),
    ).toThrow(/drainageAreaM2/)
  })
})

describe('momentum and backwater stage effects', () => {
  const run = (overrides: {
    includeMomentum?: boolean
    channelWidthM?: Float64Array
    peakDischargeM3PerS?: Float64Array
    arrivalTimeHours?: Float64Array
    peakTimeHours?: Float64Array
    invalidControl?: Uint8Array
  } = {}) => {
    const stageM = Float64Array.from([1, 1, 4])
    const result = applyHydraulicStageEffects({
      stageM,
      hand: new Float32Array(3),
      nearestChannel: Int32Array.from([0, 1, 2]),
      isChannel: Uint8Array.from([1, 1, 1]),
      rowCellAreaM2: Float64Array.from([100]),
      reachLengthM: 100,
      width: 3,
      height: 1,
      invalidControl: overrides.invalidControl,
      context: {
        elevations: Float32Array.from([2, 1, 0]),
        receivers: Int32Array.from([1, 2, -1]),
        popOrder: Int32Array.from([2, 1, 0]),
        peakDischargeM3PerS: overrides.peakDischargeM3PerS ?? Float64Array.from([8, 8, 8]),
        arrivalTimeHours: overrides.arrivalTimeHours ?? Float64Array.from([0, 0, 0]),
        peakTimeHours: overrides.peakTimeHours ?? Float64Array.from([6, 6, 6]),
        channelWidthM: overrides.channelWidthM ?? Float64Array.from([10, 10, 10]),
        channelDepthM: Float64Array.from([1, 1, 1]),
        roughness: 0.05,
        eventDurationHours: 10,
        includeMomentum: overrides.includeMomentum,
      },
    })
    return { stageM, result }
  }

  it('propagates a subcritical downstream control upstream without mutating the local solve', () => {
    const { stageM, result } = run()
    expect(Array.from(stageM)).toEqual([1, 1, 4])
    expect(result.stageM[1]).toBeGreaterThan(1)
    expect(result.stageM[0]).toBeGreaterThan(1)
    expect(result.summary.backwaterAffectedReaches).toBe(2)
    expect(result.summary.maximumBackwaterRiseM).toBeGreaterThan(0)
    expect(result.summary.maximumVelocityMPerS).toBeGreaterThan(0)
  })

  it('uses velocity head so a downstream contraction adds momentum backwater', () => {
    const noMomentum = run({
      includeMomentum: false,
      channelWidthM: Float64Array.from([20, 20, 1]),
    }).result
    const withMomentum = run({
      includeMomentum: true,
      channelWidthM: Float64Array.from([20, 20, 1]),
    }).result

    expect(withMomentum.stageM[1]).toBeGreaterThan(noMomentum.stageM[1]!)
    expect(withMomentum.summary.maximumMomentumHeadM).toBeGreaterThan(0)
    expect(withMomentum.summary.momentumAffectedReaches).toBeGreaterThan(0)
  })

  it('carries one downstream boundary time upstream without adding asynchronous momentum', () => {
    const separated = run({
      arrivalTimeHours: Float64Array.from([0, 15, 35]),
      peakTimeHours: Float64Array.from([1, 16, 36]),
    }).result
    // The late outlet peak can still push quiet water upstream (backwater), but
    // the two earlier hydrograph peaks have ended and contribute no velocity
    // head or friction to that late-time profile.
    expect(separated.stageM[1]).toBeGreaterThan(1)
    expect(separated.stageM[0]).toBeGreaterThan(1)
    expect(separated.stageM[1]! - separated.stageM[0]!).toBeCloseTo(1, 6)
  })

  it('does not propagate a ladder peg as though it were a solved boundary', () => {
    const peggedOutlet = run({ invalidControl: Uint8Array.from([0, 0, 1]) }).result
    expect(Array.from(peggedOutlet.stageM)).toEqual([1, 1, 4])
    expect(peggedOutlet.summary.backwaterAffectedReaches).toBe(0)
  })
})
