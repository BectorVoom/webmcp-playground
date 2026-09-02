import { describe, expect, it } from 'vitest'
import { planBreaches, weirBreachDischargeM3PerS, type BreachInput } from './breach'

describe('broad-crested weir breach outflow', () => {
  it('follows Q = C·B·h^1.5', () => {
    expect(weirBreachDischargeM3PerS(100, 4)).toBeCloseTo(1360, 6)
    expect(weirBreachDischargeM3PerS(50, 1)).toBeCloseTo(85, 6)
  })

  it('scales as the 3/2 power of head', () => {
    const a = weirBreachDischargeM3PerS(100, 1)
    const b = weirBreachDischargeM3PerS(100, 4)
    expect(b / a).toBeCloseTo(8, 6)
  })

  it('passes nothing with no head or no gap', () => {
    expect(weirBreachDischargeM3PerS(100, 0)).toBe(0)
    expect(weirBreachDischargeM3PerS(0, 5)).toBe(0)
    expect(weirBreachDischargeM3PerS(100, -2)).toBe(0)
  })
})

describe('breach planning', () => {
  const base = (over: Partial<BreachInput> = {}): BreachInput => ({
    candidates: [0],
    drainageAreaM2: Float64Array.from([5e8]),
    overtopRatio: Float64Array.from([2]),
    channelDepthM: Float64Array.from([3]),
    routedVolumeM3: Float64Array.from([1e9]),
    conveyanceM3: Float64Array.from([1e8]),
    durationSeconds: 86400,
    breachWidthM: 100,
    maxBreaches: 3,
    minSeparationCells: 5,
    width: 100,
    ...over,
  })

  it('produces a breach with weir-consistent discharge and volume', () => {
    const [breach] = planBreaches(base())
    expect(breach).toBeDefined()
    // ratio 2 -> excess 1 -> head = depth x (1 + 1) = 6 m
    expect(breach!.headM).toBeCloseTo(6, 6)
    expect(breach!.dischargeM3PerS).toBeCloseTo(1.7 * 100 * 6 ** 1.5, 0)
    expect(breach!.drainageAreaKm2).toBeCloseTo(500, 6)
  })

  it('never releases more water than the channel actually carries in excess', () => {
    // Excess volume is only 1000 m3; the weir alone would pass millions.
    const [breach] = planBreaches(
      base({ routedVolumeM3: Float64Array.from([1e8 + 1000]), conveyanceM3: Float64Array.from([1e8]) }),
    )
    expect(breach!.volumeM3).toBe(1000)
  })

  it('skips a reach that is within capacity', () => {
    expect(
      planBreaches(
        base({ routedVolumeM3: Float64Array.from([5e7]), conveyanceM3: Float64Array.from([1e8]) }),
      ),
    ).toHaveLength(0)
  })

  it('thins candidates that sit on the same reach, and honours the cap', () => {
    const n = 40
    const arr = (v: number) => Float64Array.from({ length: n }, () => v)
    // Candidates one cell apart on one row: only the separated ones survive.
    const input = base({
      candidates: [0, 1, 2, 3, 10, 11, 20],
      drainageAreaM2: arr(5e8),
      overtopRatio: arr(2),
      channelDepthM: arr(3),
      routedVolumeM3: arr(1e9),
      conveyanceM3: arr(1e8),
      width: 100,
      minSeparationCells: 5,
      maxBreaches: 3,
    })
    const sites = planBreaches(input)
    expect(sites.map((s) => s.cell)).toEqual([0, 10, 20])
  })

  it('respects maxBreaches', () => {
    const n = 60
    const arr = (v: number) => Float64Array.from({ length: n }, () => v)
    const sites = planBreaches(
      base({
        candidates: [0, 10, 20, 30, 40, 50],
        drainageAreaM2: arr(5e8),
        overtopRatio: arr(2),
        channelDepthM: arr(3),
        routedVolumeM3: arr(1e9),
        conveyanceM3: arr(1e8),
        maxBreaches: 2,
      }),
    )
    expect(sites).toHaveLength(2)
  })
})
