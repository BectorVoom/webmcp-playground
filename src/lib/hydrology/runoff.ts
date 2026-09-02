/**
 * Rainfall-to-runoff conversion by the SCS Curve Number method (USDA-NRCS,
 * "Urban Hydrology for Small Watersheds", Technical Release 55, 1986).
 *
 * The method turns an event rainfall depth P into an effective runoff depth Q —
 * the share of the rain that neither infiltrates nor is caught by surface
 * storage, and is therefore available to pond. It is the standard screening
 * model for exactly this question, which is why it is used here rather than a
 * calibrated infiltration model this project has no soil data to feed.
 */

export interface RunoffEstimate {
  readonly rainfallMm: number
  readonly curveNumber: number
  /** S: maximum potential retention after runoff begins (TR-55 eq. 2-4). */
  readonly potentialRetentionMm: number
  /** Ia = 0.2·S: losses before runoff begins — interception, surface storage, early infiltration. */
  readonly initialAbstractionMm: number
  /** Q: the depth of water that runs off and can pond downslope. */
  readonly runoffMm: number
}

/**
 * TR-55 table 2-2a, "residential, 1/4-acre lots" on hydrologic soil group C —
 * a deliberately middling default for mixed suburban terrain, used only when
 * the caller supplies no curve number of their own.
 */
export const DEFAULT_CURVE_NUMBER = 80

/** TR-55 curve numbers below ~30 describe surfaces that produce no meaningful event runoff. */
export const MIN_CURVE_NUMBER = 30
export const MAX_CURVE_NUMBER = 100

/**
 * TR-55 equations 2-3/2-4 with the classic Ia = 0.2·S initial abstraction.
 *
 * Q = (P − Ia)² / (P − Ia + S) for P > Ia, else 0, with S = 25400/CN − 254 (mm).
 */
export const estimateRunoff = (rainfallMm: number, curveNumber = DEFAULT_CURVE_NUMBER): RunoffEstimate => {
  if (!Number.isFinite(rainfallMm) || rainfallMm < 0) {
    throw new RangeError(`rainfallMm must be a non-negative number, got ${rainfallMm}`)
  }
  if (!Number.isFinite(curveNumber) || curveNumber < MIN_CURVE_NUMBER || curveNumber > MAX_CURVE_NUMBER) {
    throw new RangeError(
      `curveNumber must be between ${MIN_CURVE_NUMBER} and ${MAX_CURVE_NUMBER}, got ${curveNumber}`,
    )
  }

  const potentialRetentionMm = 25400 / curveNumber - 254
  const initialAbstractionMm = 0.2 * potentialRetentionMm
  const excess = rainfallMm - initialAbstractionMm
  const runoffMm = excess > 0 ? (excess * excess) / (excess + potentialRetentionMm) : 0

  return {
    rainfallMm,
    curveNumber,
    potentialRetentionMm,
    initialAbstractionMm,
    runoffMm,
  }
}
