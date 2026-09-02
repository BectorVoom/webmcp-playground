/**
 * Levee breach outflow.
 *
 * A breach is modelled as a broad-crested weir in the levee line: once the
 * embankment fails, the discharge through the gap is set by its width and by
 * the head of water standing above the breach invert. This is the same
 * formulation HEC-RAS uses for a levee or dam breach, reduced to its
 * steady-state core — there is no breach growth curve here, because a
 * screening model with no time axis has nowhere to put one.
 *
 * References:
 *  - Broad-crested weir discharge: Chow (1959), "Open-Channel Hydraulics", §14.
 *  - Breach parameterisation practice: USACE HEC-RAS Hydraulic Reference Manual,
 *    "Levee and dam breach"; Froehlich (2008) for typical breach widths.
 */

/**
 * Broad-crested weir coefficient in SI units. Chow (1959) gives C ≈ 1.7 for a
 * broad-crested weir with a rounded upstream corner, which is the closest
 * standard analogue to a failed earth embankment.
 */
export const WEIR_COEFFICIENT = 1.7

/** Typical earth-levee breach width. Froehlich (2008) puts most failures in the 50–200 m range. */
export const DEFAULT_BREACH_WIDTH_M = 100

/**
 * Weir discharge through a breach: Q = C·B·h^{3/2}.
 *
 * `headM` is the water surface in the channel above the breach invert — for an
 * embankment that has failed to its toe, that is the channel stage above the
 * floodplain it protects.
 */
export const weirBreachDischargeM3PerS = (
  widthM: number,
  headM: number,
  coefficient = WEIR_COEFFICIENT,
): number => {
  if (widthM <= 0 || headM <= 0) return 0
  return coefficient * widthM * headM ** 1.5
}

export interface BreachSite {
  /** Grid cell of the channel reach that fails. */
  readonly cell: number
  readonly widthM: number
  /** Head driving the outflow, metres above the protected floodplain. */
  readonly headM: number
  readonly dischargeM3PerS: number
  /** Volume delivered onto the floodplain over the event, m³. */
  readonly volumeM3: number
  readonly drainageAreaKm2: number
  /** Discharge/capacity of the reach when it failed. */
  readonly overtopRatio: number
}

export interface BreachInput {
  /** Candidate channel cells, already ranked by the caller (most stressed first). */
  readonly candidates: ReadonlyArray<number>
  readonly drainageAreaM2: Float64Array
  readonly overtopRatio: Float64Array
  readonly channelDepthM: Float64Array
  /** Volume routed past each cell over the event, m³. */
  readonly routedVolumeM3: Float64Array
  /** Volume the channel can carry past each cell over the event, m³. */
  readonly conveyanceM3: Float64Array
  readonly durationSeconds: number
  readonly breachWidthM: number
  readonly maxBreaches: number
  /** Minimum separation between breaches, in cells, so one reach is not counted twice. */
  readonly minSeparationCells: number
  readonly width: number
}

/**
 * Chooses breach sites and computes what each one delivers to the floodplain.
 *
 * Sites are taken from the most-over-capacity reaches, thinned so that two
 * breaches are never on top of each other. Outflow is the weir discharge, but
 * capped at the volume actually available in the channel above capacity: a
 * breach cannot pass water the river does not have, and an uncapped weir
 * equation will happily invent it.
 */
export const planBreaches = (input: BreachInput): ReadonlyArray<BreachSite> => {
  const {
    candidates, drainageAreaM2, overtopRatio, channelDepthM, routedVolumeM3,
    conveyanceM3, durationSeconds, breachWidthM, maxBreaches, minSeparationCells, width,
  } = input

  const chosen: Array<BreachSite> = []
  for (const cell of candidates) {
    if (chosen.length >= maxBreaches) break

    const cx = cell % width
    const cy = Math.floor(cell / width)
    const tooClose = chosen.some((site) => {
      const sx = site.cell % width
      const sy = Math.floor(site.cell / width)
      return Math.hypot(cx - sx, cy - sy) < minSeparationCells
    })
    if (tooClose) continue

    // Head above the protected floodplain: the channel is full to bankfull and
    // the excess stands above it, so the driving head is the bankfull depth
    // plus however far the flow overtops it, capped at a physically sane value.
    const excessRatio = Math.max(0, overtopRatio[cell]! - 1)
    const headM = Math.min(channelDepthM[cell]! * (1 + Math.min(excessRatio, 1)), 10)
    const dischargeM3PerS = weirBreachDischargeM3PerS(breachWidthM, headM)

    const availableM3 = Math.max(0, routedVolumeM3[cell]! - conveyanceM3[cell]!)
    const volumeM3 = Math.min(dischargeM3PerS * durationSeconds, availableM3)
    if (volumeM3 <= 0) continue

    chosen.push({
      cell,
      widthM: breachWidthM,
      headM: Math.round(headM * 100) / 100,
      dischargeM3PerS: Math.round(dischargeM3PerS * 10) / 10,
      volumeM3: Math.round(volumeM3),
      drainageAreaKm2: Math.round((drainageAreaM2[cell]! / 1e6) * 10) / 10,
      overtopRatio: Math.round(overtopRatio[cell]! * 100) / 100,
    })
  }
  return chosen
}
