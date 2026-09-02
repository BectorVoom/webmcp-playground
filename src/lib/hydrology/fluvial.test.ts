import { describe, expect, it } from 'vitest'
import {
  combineDepths,
  fluvialInundation,
  heightAboveDrainage,
  type FluvialInput,
  type FluvialResult,
} from './fluvial'
import { channelMask, d8Receivers, flowAccumulate, priorityFlood, type GridGeometry } from './flow'

const uniformGeometry = (height: number, metres = 100): GridGeometry => ({
  rowCellWidthM: new Float64Array(height).fill(metres),
  rowCellHeightM: new Float64Array(height).fill(metres),
  rowCellAreaM2: new Float64Array(height).fill(metres * metres),
})

/**
 * A valley: a channel along the middle row falling west to east, with ground
 * rising 2 m per row away from it.
 */
const valley = (width: number, height: number): Float32Array => {
  const e = new Float32Array(width * height)
  const axis = Math.floor(height / 2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      e[y * width + x] = 100 - x * 0.5 + Math.abs(y - axis) * 2
    }
  }
  return e
}

describe('height above nearest drainage', () => {
  it('measures each cell against the river it drains to', () => {
    const width = 20
    const height = 9
    const elevations = valley(width, height)
    const geometry = uniformGeometry(height)
    const surface = priorityFlood(elevations, width, height)
    const receivers = d8Receivers(surface, width, height, geometry)
    const areas = new Float64Array(width * height).fill(10_000)
    const accumulated = flowAccumulate(receivers, surface.popOrder, areas)
    // Threshold low enough that the valley axis counts as a channel.
    const isChannel = channelMask(accumulated, 150_000)

    const { hand, nearestChannel } = heightAboveDrainage(elevations, receivers, surface.popOrder, isChannel)

    const axis = Math.floor(height / 2)
    // Contributing area only reaches the channel threshold once enough of the
    // valley has drained in, so the axis is a channel over its lower reach.
    let channelCells = 0
    for (let x = 1; x < width - 1; x++) {
      if (!isChannel[axis * width + x]) continue
      channelCells++
      expect(hand[axis * width + x]).toBe(0)
    }
    expect(channelCells).toBeGreaterThan(5)
    // A cell on the valley side stands above the river it reaches.
    const side = (axis - 2) * width + 10
    expect(nearestChannel[side]).toBeGreaterThanOrEqual(0)
    expect(hand[side]).toBeGreaterThan(0)
    expect(hand[side]).toBeLessThan(20)
  })

  it('never reports a negative height above drainage', () => {
    const width = 16
    const height = 7
    const elevations = valley(width, height)
    const geometry = uniformGeometry(height)
    const surface = priorityFlood(elevations, width, height)
    const receivers = d8Receivers(surface, width, height, geometry)
    const areas = new Float64Array(width * height).fill(10_000)
    const isChannel = channelMask(flowAccumulate(receivers, surface.popOrder, areas), 120_000)
    const { hand } = heightAboveDrainage(elevations, receivers, surface.popOrder, isChannel)
    for (const h of hand) expect(h).toBeGreaterThanOrEqual(0)
  })
})

describe('fluvial inundation from river stage', () => {
  /** Channel roughness these cases are driven with, named so the compound tests can match it. */
  const CHANNEL_N = 0.05

  const build = (width: number, height: number) => {
    const elevations = valley(width, height)
    const geometry = uniformGeometry(height)
    const surface = priorityFlood(elevations, width, height)
    const receivers = d8Receivers(surface, width, height, geometry)
    const areas = new Float64Array(width * height).fill(10_000)
    const isChannel = channelMask(flowAccumulate(receivers, surface.popOrder, areas), 150_000)
    const { hand, nearestChannel } = heightAboveDrainage(elevations, receivers, surface.popOrder, isChannel)
    const slope = new Float64Array(width * height).fill(0.005)
    return { elevations, geometry, isChannel, hand, nearestChannel, slope }
  }

  const run = (
    width: number,
    height: number,
    dischargePerChannelCell: number,
    overrides: Partial<FluvialInput> = {},
  ) => {
    const { geometry, isChannel, hand, nearestChannel, slope } = build(width, height)
    const discharge = new Float64Array(width * height)
    for (let i = 0; i < width * height; i++) if (isChannel[i]) discharge[i] = dischargePerChannelCell
    return fluvialInundation({
      hand,
      nearestChannel,
      isChannel,
      dischargeM3PerS: discharge,
      slope,
      rowCellAreaM2: geometry.rowCellAreaM2,
      reachLengthM: 100,
      width,
      height,
      roughness: CHANNEL_N,
      ...overrides,
    })
  }

  it('leaves the valley dry when no water is moving', () => {
    const result = run(20, 9, 0)
    expect(result.wetCells).toBe(0)
    expect(result.maxStageM).toBe(0)
    expect(Math.max(...result.depths)).toBe(0)
  })

  describe('compound section, channel and floodplain roughness apart', () => {
    it('reduces to the single-section curve when both roughnesses agree', () => {
      const single = run(20, 9, 500)
      const composite = run(20, 9, 500, { floodplainRoughness: CHANNEL_N })

      // Exactly, not approximately: a composite n over one roughness is that
      // roughness. Anything else would mean the compound path had smuggled in a
      // geometry change alongside the roughness one, and the measurement could
      // not tell them apart.
      expect(composite.maxStageM).toBe(single.maxStageM)
      expect(composite.wetCells).toBe(single.wetCells)
    })

    it('needs a higher stage to pass the same flow once the floodplain is rough', () => {
      const single = run(20, 9, 500)
      const rough = run(20, 9, 500, { floodplainRoughness: 0.15 })

      // The floodplain is most of the width, so making it three times rougher
      // takes conveyance away and the curve has to climb to replace it.
      expect(rough.maxStageM).toBeGreaterThan(single.maxStageM)
      expect(rough.wetCells).toBeGreaterThan(single.wetCells)
    })

    it('floods more ground the rougher the floodplain is', () => {
      const gentle = run(20, 9, 500, { floodplainRoughness: 0.08 })
      const rough = run(20, 9, 500, { floodplainRoughness: 0.25 })
      expect(rough.maxStageM).toBeGreaterThan(gentle.maxStageM)
      expect(rough.wetCells).toBeGreaterThan(gentle.wetCells)
    })

    it('the divided method always sits at or below the composite one', () => {
      // The whole difference between the two: the channel sub-section has a far
      // larger hydraulic radius than the section average, so summing the parts
      // carries more than treating them as one. Splitting therefore adds
      // conveyance on its own and pulls the stage back down, working against
      // the roughness it was introduced to apply. That is why the choice
      // between them is a measurement and not a preference.
      for (const floodplainRoughness of [CHANNEL_N, 0.1, 0.2]) {
        const composite = run(20, 9, 500, { floodplainRoughness })
        const divided = run(20, 9, 500, { floodplainRoughness, compoundMethod: 'divided' })
        expect(divided.maxStageM).toBeLessThanOrEqual(composite.maxStageM)
        expect(divided.wetCells).toBeLessThanOrEqual(composite.wetCells)
      }
    })

    it('leaves a reach carrying nothing dry however rough its floodplain', () => {
      for (const compoundMethod of ['composite', 'divided'] as const) {
        expect(run(20, 9, 0, { floodplainRoughness: 0.2, compoundMethod }).wetCells).toBe(0)
      }
    })
  })

  describe('uniform stage, the diagnostic that bounds the method', () => {
    it('stands every flowing reach at the given height whatever it is carrying', () => {
      const small = run(20, 9, 50, { uniformStageM: 3 })
      const large = run(20, 9, 5000, { uniformStageM: 3 })

      expect(small.maxStageM).toBe(3)
      expect(large.maxStageM).toBe(3)
      // The rating curve is skipped entirely, so a hundredfold discharge maps
      // exactly the same ground — which is what makes a sweep of this a
      // measurement of HAND rather than of the hydraulics.
      expect(large.wetCells).toBe(small.wetCells)
      expect(large.peggedReaches).toBe(0)
    })

    it('still leaves a reach carrying nothing dry', () => {
      const result = run(20, 9, 0, { uniformStageM: 5 })
      expect(result.wetCells).toBe(0)
      expect(result.maxStageM).toBe(0)
    })

    it('wets more ground as the stage rises', () => {
      const shallow = run(20, 9, 500, { uniformStageM: 1 })
      const deep = run(20, 9, 500, { uniformStageM: 6 })
      expect(deep.wetCells).toBeGreaterThan(shallow.wetCells)
    })
  })

  it('raises stage, depth and extent as discharge grows', () => {
    const small = run(20, 9, 20)
    const large = run(20, 9, 2000)
    expect(small.wetCells).toBeGreaterThan(0)
    expect(large.maxStageM).toBeGreaterThan(small.maxStageM)
    expect(large.wetCells).toBeGreaterThan(small.wetCells)
    expect(Math.max(...large.depths)).toBeGreaterThan(Math.max(...small.depths))
  })

  it('floods the valley floor before the valley sides', () => {
    const width = 20
    const height = 9
    const { hand } = build(width, height)
    const result = run(width, height, 300)
    for (let i = 0; i < width * height; i++) {
      // Anything wet stands below the stage of the reach it drains to.
      if (result.depths[i]! > 0) expect(hand[i]!).toBeLessThan(result.maxStageM + 1e-6)
    }
  })

  it('never inundates a cell that drains to no channel at all', () => {
    const width = 12
    const height = 5
    const elevations = new Float32Array(width * height).fill(50)
    const geometry = uniformGeometry(height)
    const surface = priorityFlood(elevations, width, height)
    const receivers = d8Receivers(surface, width, height, geometry)
    const isChannel = new Uint8Array(width * height) // no channels anywhere
    const { hand, nearestChannel } = heightAboveDrainage(elevations, receivers, surface.popOrder, isChannel)
    const result = fluvialInundation({
      hand,
      nearestChannel,
      isChannel,
      dischargeM3PerS: new Float64Array(width * height).fill(500),
      slope: new Float64Array(width * height).fill(0.01),
      rowCellAreaM2: geometry.rowCellAreaM2,
      reachLengthM: 100,
      width,
      height,
      roughness: 0.05,
    })
    expect(result.wetCells).toBe(0)
  })
})

describe('flood defences and the cumulative available-volume check', () => {
  const scene = (width: number, height: number) => {
    const elevations = valley(width, height)
    const geometry = uniformGeometry(height)
    const surface = priorityFlood(elevations, width, height)
    const receivers = d8Receivers(surface, width, height, geometry)
    const areas = new Float64Array(width * height).fill(10_000)
    const isChannel = channelMask(flowAccumulate(receivers, surface.popOrder, areas), 150_000)
    const { hand, nearestChannel } = heightAboveDrainage(elevations, receivers, surface.popOrder, isChannel)
    const discharge = new Float64Array(width * height)
    for (let i = 0; i < width * height; i++) if (isChannel[i]) discharge[i] = 500
    return {
      base: {
        hand,
        nearestChannel,
        isChannel,
        dischargeM3PerS: discharge,
        slope: new Float64Array(width * height).fill(0.005),
        rowCellAreaM2: geometry.rowCellAreaM2,
        reachLengthM: 100,
        width,
        height,
        roughness: 0.05,
      },
      hand,
      nearestChannel,
      receivers,
      popOrder: surface.popOrder,
      isChannel,
      cells: width * height,
    }
  }

  /** Storage each reach's own strip holds at the stage it was assigned, m³. */
  const stripStorage = (
    result: FluvialResult,
    hand: Float32Array,
    nearestChannel: Int32Array,
    cellAreaM2: number,
  ): Float64Array => {
    const storage = new Float64Array(result.stageM.length)
    for (let i = 0; i < result.stageM.length; i++) {
      const target = nearestChannel[i]!
      if (target < 0) continue
      const depth = result.stageM[target]! - hand[i]!
      if (depth > 0) storage[target]! += depth * cellAreaM2
    }
    return storage
  }

  it('leaves a reach dry while its defences hold, and floods it once overtopped', () => {
    const { base, isChannel, cells } = scene(20, 9)
    const held = new Float64Array(cells)
    const overtopped = new Float64Array(cells)
    for (let i = 0; i < cells; i++) {
      if (!isChannel[i]) continue
      held[i] = 1000 // defended well above the 500 m³/s flowing
      overtopped[i] = 100 // defences exceeded
    }

    const defended = fluvialInundation({ ...base, defendedCapacityM3PerS: held })
    expect(defended.wetCells).toBe(0)
    expect(defended.defendedReaches).toBeGreaterThan(0)

    const failed = fluvialInundation({ ...base, defendedCapacityM3PerS: overtopped })
    expect(failed.wetCells).toBeGreaterThan(0)
    expect(failed.defendedReaches).toBe(0)
  })

  it('spreads only the excess over the defences, and does so without a cliff', () => {
    const { base, isChannel, cells } = scene(20, 9)
    const defence = (m3PerS: number) => {
      const d = new Float64Array(cells)
      for (let i = 0; i < cells; i++) if (isChannel[i]) d[i] = m3PerS
      return d
    }

    // Solved for the total discharge, the defence is a switch: the extent is
    // whatever 500 m³/s implies right up to the crest, then nothing.
    const totalJustBelow = fluvialInundation({ ...base, defendedCapacityM3PerS: defence(499) })
    const totalUndefended = fluvialInundation({ ...base, defendedCapacityM3PerS: defence(0) })
    expect(totalJustBelow.wetCells).toBe(totalUndefended.wetCells)

    // Solved for the excess, it is a ramp: 1 m³/s over the crest wets far less
    // than 500 does, and the extent grows monotonically as the defence falls.
    const excess = (m3PerS: number) =>
      fluvialInundation({ ...base, stageDischarge: 'excess', defendedCapacityM3PerS: defence(m3PerS) })
    const justBelow = excess(499)
    expect(justBelow.wetCells).toBeGreaterThan(0)
    expect(justBelow.wetCells).toBeLessThan(totalUndefended.wetCells)
    let previous = 0
    for (const held of [499, 400, 250, 100, 0]) {
      const wet = excess(held).wetCells
      expect(wet).toBeGreaterThanOrEqual(previous)
      previous = wet
    }
    expect(excess(500).wetCells).toBe(0)
  })

  it('holds the stage down to the water the river actually delivered', () => {
    const { base, receivers, popOrder, cells } = scene(20, 9)
    const undefended = new Float64Array(cells)
    const constraint = (durationSeconds: number) =>
      fluvialInundation({
        ...base,
        volumeConstraint: true,
        receivers,
        popOrder,
        durationSeconds,
        defendedCapacityM3PerS: undefended,
      })

    // 500 m³/s for a day is far more water than this valley can hold.
    const unlimited = constraint(86_400)
    // The same discharge for two minutes is not.
    const limited = constraint(120)

    expect(unlimited.volumeLimitedReaches).toBe(0)
    expect(limited.volumeLimitedReaches).toBeGreaterThan(0)
    expect(limited.maxStageM).toBeLessThan(unlimited.maxStageM)
    expect(limited.wetCells).toBeLessThan(unlimited.wetCells)
    expect(limited.wetCells).toBeGreaterThan(0)
  })

  it('binds at the scale of the network, where a per-reach comparison never could', () => {
    const { base, hand, nearestChannel, receivers, popOrder, isChannel, cells } = scene(20, 9)
    const durationSeconds = 600
    const unconstrained = fluvialInundation({ ...base })
    const constrained = fluvialInundation({
      ...base,
      volumeConstraint: true,
      receivers,
      popOrder,
      durationSeconds,
      defendedCapacityM3PerS: new Float64Array(cells),
    })

    // The per-reach test this replaced compared one strip's storage against the
    // whole upstream river's overbank volume, so it passed everywhere...
    const overbankM3 = 500 * durationSeconds
    const storage = stripStorage(unconstrained, hand, nearestChannel, 10_000)
    for (let c = 0; c < cells; c++) {
      if (!isChannel[c]) continue
      expect(storage[c]!).toBeLessThan(overbankM3)
    }
    // ...while the cumulative test, which is the scale the physics is at, bites.
    expect(constrained.volumeLimitedReaches).toBeGreaterThan(0)
  })

  it('refuses the volume constraint without the network to accumulate over', () => {
    const { base } = scene(20, 9)
    expect(() => fluvialInundation({ ...base, volumeConstraint: true })).toThrow(/receivers/)
    expect(fluvialInundation({ ...base }).volumeBudget).toBeNull()
  })

  it('reports the budget it would have applied even when it is not allowed to', () => {
    const { base, receivers, popOrder, cells } = scene(20, 9)
    const shared = {
      ...base, receivers, popOrder, durationSeconds: 120,
      defendedCapacityM3PerS: new Float64Array(cells),
    }
    const reported = fluvialInundation({ ...shared, volumeConstraint: false })
    const applied = fluvialInundation({ ...shared, volumeConstraint: true })

    // Same budget either way; only one of them acts on it.
    expect(reported.volumeBudget!.reachesOverBudget).toBe(applied.volumeBudget!.reachesOverBudget)
    expect(reported.volumeBudget!.reachesOverBudget).toBeGreaterThan(0)
    expect(reported.volumeBudget!.minimumSupportedShare).toBeLessThan(1)
    expect(reported.volumeLimitedReaches).toBe(0)
    expect(applied.volumeLimitedReaches).toBeGreaterThan(0)
    expect(reported.wetCells).toBeGreaterThan(applied.wetCells)
  })

  it('counts reaches whose discharge runs off the end of the ladder', () => {
    const { base, isChannel, cells } = scene(20, 9)
    const huge = new Float64Array(cells)
    for (let i = 0; i < cells; i++) if (isChannel[i]) huge[i] = 5_000_000
    const result = fluvialInundation({ ...base, dischargeM3PerS: huge })
    expect(result.peggedReaches).toBeGreaterThan(0)
    // The mask is the count, cell by cell: only channel cells carry it, and a
    // solvable discharge leaves it empty.
    const marked = result.pegged.reduce((sum, v) => sum + v, 0)
    expect(marked).toBe(result.peggedReaches)
    result.pegged.forEach((flag, c) => {
      if (flag) expect(isChannel[c]).toBe(1)
    })
    const solved = fluvialInundation({ ...base })
    expect(solved.pegged.reduce((sum, v) => sum + v, 0)).toBe(solved.peggedReaches)
  })
})

describe('along-channel stage smoothing', () => {
  const scene = (width: number, height: number) => {
    const elevations = valley(width, height)
    const geometry = uniformGeometry(height)
    const surface = priorityFlood(elevations, width, height)
    const receivers = d8Receivers(surface, width, height, geometry)
    const areas = new Float64Array(width * height).fill(10_000)
    const isChannel = channelMask(flowAccumulate(receivers, surface.popOrder, areas), 150_000)
    const { hand, nearestChannel } = heightAboveDrainage(elevations, receivers, surface.popOrder, isChannel)
    return {
      base: {
        hand, nearestChannel, isChannel,
        dischargeM3PerS: new Float64Array(width * height),
        slope: new Float64Array(width * height).fill(0.005),
        rowCellAreaM2: geometry.rowCellAreaM2,
        reachLengthM: 100,
        width, height,
        roughness: 0.05,
      },
      receivers, isChannel,
      cells: width * height,
    }
  }

  /** Alternating discharge along one river: the raw solve zigzags, a water surface must not. */
  const zigzag = (isChannel: Uint8Array, cells: number): Float64Array => {
    const discharge = new Float64Array(cells)
    let odd = false
    for (let i = 0; i < cells; i++) {
      if (!isChannel[i]) continue
      discharge[i] = odd ? 1500 : 100
      odd = !odd
    }
    return discharge
  }

  const maxJumpBetweenNeighbours = (
    stageM: Float64Array, receivers: Int32Array, isChannel: Uint8Array,
  ): number => {
    let worst = 0
    for (let c = 0; c < stageM.length; c++) {
      if (!isChannel[c] || !(stageM[c]! > 0)) continue
      const r = receivers[c]!
      if (r < 0 || !isChannel[r] || !(stageM[r]! > 0)) continue
      worst = Math.max(worst, Math.abs(stageM[c]! - stageM[r]!))
    }
    return worst
  }

  it('needs receivers to know the channel topology', () => {
    const { base } = scene(20, 9)
    expect(() => fluvialInundation({ ...base, stageSmoothingM: 2000 })).toThrow(/receivers/)
  })

  it('is off by default and at zero', () => {
    const { base, receivers, isChannel, cells } = scene(20, 9)
    const dischargeM3PerS = zigzag(isChannel, cells)
    const raw = fluvialInundation({ ...base, dischargeM3PerS })
    const zero = fluvialInundation({ ...base, dischargeM3PerS, receivers, stageSmoothingM: 0 })
    expect(Array.from(zero.stageM)).toEqual(Array.from(raw.stageM))
  })

  it('evens neighbouring stages without leaving the solved range', () => {
    const { base, receivers, isChannel, cells } = scene(40, 9)
    const dischargeM3PerS = zigzag(isChannel, cells)
    const raw = fluvialInundation({ ...base, dischargeM3PerS })
    const smooth = fluvialInundation({ ...base, dischargeM3PerS, receivers, stageSmoothingM: 1000 })

    const rawJump = maxJumpBetweenNeighbours(raw.stageM, receivers, isChannel)
    const smoothJump = maxJumpBetweenNeighbours(smooth.stageM, receivers, isChannel)
    expect(rawJump).toBeGreaterThan(0)
    expect(smoothJump).toBeLessThan(rawJump)

    // An average cannot invent a stage outside what was solved.
    let rawMin = Infinity
    let rawMax = 0
    for (let c = 0; c < cells; c++) {
      if (!isChannel[c] || !(raw.stageM[c]! > 0)) continue
      rawMin = Math.min(rawMin, raw.stageM[c]!)
      rawMax = Math.max(rawMax, raw.stageM[c]!)
    }
    for (let c = 0; c < cells; c++) {
      if (!isChannel[c] || !(smooth.stageM[c]! > 0)) continue
      expect(smooth.stageM[c]!).toBeGreaterThanOrEqual(rawMin - 1e-9)
      expect(smooth.stageM[c]!).toBeLessThanOrEqual(rawMax + 1e-9)
    }
  })

  it('re-estimates a lone pegged reach from its solved neighbours', () => {
    const { base, receivers, isChannel, cells } = scene(40, 9)
    const dischargeM3PerS = new Float64Array(cells)
    const channelCells: Array<number> = []
    for (let i = 0; i < cells; i++) {
      if (!isChannel[i]) continue
      channelCells.push(i)
      dischargeM3PerS[i] = 500
    }
    const middle = channelCells[Math.floor(channelCells.length / 2)]!
    dischargeM3PerS[middle] = 5_000_000

    const raw = fluvialInundation({ ...base, dischargeM3PerS })
    expect(raw.pegged[middle]).toBe(1)
    const topStage = raw.stageM[middle]!

    const smooth = fluvialInundation({ ...base, dischargeM3PerS, receivers, stageSmoothingM: 1000 })
    // Still reported as pegged — the ladder did fail there — but the mapped
    // stage is its neighbours' consensus, not the top of the ladder.
    expect(smooth.pegged[middle]).toBe(1)
    expect(smooth.stageM[middle]!).toBeLessThan(topStage)
    expect(smooth.stageM[middle]!).toBeGreaterThan(0)
  })
})

describe('combining the two inundation mechanisms', () => {
  it('takes the deeper of the two, never the sum', () => {
    const a = Float32Array.from([0, 2, 5, 0])
    const b = Float32Array.from([1, 4, 3, 0])
    expect(Array.from(combineDepths(a, b))).toEqual([1, 4, 5, 0])
  })
})
