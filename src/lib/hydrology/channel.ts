/**
 * Channel geometry and conveyance capacity.
 *
 * A DEM at 30–90 m does not resolve a river channel: the channel is narrower
 * than one cell almost everywhere, so its cross-section has to be inferred
 * rather than measured. The standard inference is downstream hydraulic
 * geometry — bankfull width and depth scale as power laws of upstream drainage
 * area — combined with Manning's equation for the discharge that cross-section
 * can carry.
 *
 * References:
 *  - Leopold & Maddock (1953), "The hydraulic geometry of stream channels and
 *    some physiographic implications", USGS Professional Paper 252.
 *  - Bieger, Rathjens, Allen & Arnold (2015), "Development and Evaluation of
 *    Bankfull Hydraulic Geometry Relationships for the Physiographic Regions of
 *    the United States", JAWRA 51(4) — the coefficients used below.
 *  - Manning (1891), via Chow (1959), "Open-Channel Hydraulics".
 *  - Moody & Troutman (2002), "Characterization of the spatial variability of
 *    channel morphology", Earth Surf. Process. Landforms 27 — the
 *    discharge-keyed relations, as compiled in Andreadis et al. (2013), "A
 *    simple global river bankfull width and depth database", Water Resour. Res.
 *    49. These hold across the full range of river sizes, which the
 *    area-keyed relations below do not.
 */

/**
 * Bankfull width, metres, from upstream drainage area in km².
 *
 * Bieger et al. (2015) national relation, W = 2.70·A^0.352. It is derived from
 * US gauged basins and applied here worldwide, which is the single largest
 * source of bias in channel capacity outside the US — a stated limitation, not
 * a hidden one.
 */
export const bankfullWidthMetres = (areaKm2: number): number => 2.7 * Math.max(areaKm2, 1e-6) ** 0.352

/** Bankfull mean depth, metres, from upstream drainage area in km² (Bieger et al. 2015). */
export const bankfullDepthMetres = (areaKm2: number): number => 0.3 * Math.max(areaKm2, 1e-6) ** 0.213

/**
 * Manning's equation for a rectangular channel:
 * Q = (1/n)·A·R^(2/3)·S^(1/2), with R = A/P the hydraulic radius.
 */
export const manningDischargeM3PerS = (
  widthM: number,
  depthM: number,
  slope: number,
  roughness: number,
): number => {
  if (widthM <= 0 || depthM <= 0 || slope <= 0 || roughness <= 0) return 0
  const area = widthM * depthM
  const wettedPerimeter = widthM + 2 * depthM
  const hydraulicRadius = area / wettedPerimeter
  return (1 / roughness) * area * hydraulicRadius ** (2 / 3) * Math.sqrt(slope)
}

/**
 * Manning's n for a natural channel with some bed material and vegetation.
 * Chow (1959) table 5-6: major streams, clean and winding, run 0.025–0.045.
 */
export const DEFAULT_MANNING_N = 0.035

/** Drainage area at which a hillslope is taken to have become a channel. */
export const DEFAULT_CHANNEL_THRESHOLD_KM2 = 10

/**
 * Bankfull width, metres, from bankfull discharge (Moody & Troutman 2002):
 * W = 7.2·Q^0.50. Keyed on discharge rather than catchment area, so it stays
 * valid from a headwater ditch to a continental river.
 */
export const bankfullWidthFromDischarge = (dischargeM3PerS: number): number =>
  7.2 * Math.max(dischargeM3PerS, 1e-6) ** 0.5

/** Bankfull mean depth, metres, from bankfull discharge: D = 0.27·Q^0.30. */
export const bankfullDepthFromDischarge = (dischargeM3PerS: number): number =>
  0.27 * Math.max(dischargeM3PerS, 1e-6) ** 0.3

export interface ChannelGeometry {
  readonly widthM: Float64Array
  readonly depthM: Float64Array
  /** Bankfull discharge the channel can carry before going overbank, m³/s. */
  readonly capacityM3PerS: Float64Array
}

/**
 * Per-cell channel cross-section and bankfull capacity.
 *
 * Two ways to get there, and they are not equally good.
 *
 * When a **bankfull discharge** is supplied — the mean annual flood, derived
 * from the catchment's own rainfall climatology — it *is* the capacity, because
 * a channel is in equilibrium with roughly its two-year flow by definition, and
 * the cross-section follows from it by Moody & Troutman. That route avoids
 * Manning entirely, which matters: capacity would otherwise scale with the
 * square root of a slope that is mostly DEM quantisation on flat ground.
 *
 * Without one it falls back to area-keyed hydraulic geometry through Manning.
 * That fallback is known to understate large rivers by two to four orders of
 * magnitude — Bieger et al. is calibrated on US streams and these catchments
 * are far outside its range — so it exists only to keep the model running when
 * climatology is unavailable, and the caller is told which route was used.
 *
 * Non-channel cells get zero capacity: a hillslope conveys water downslope but
 * holds none of it in a channel.
 */
export const channelGeometry = (
  drainageAreaM2: Float64Array,
  slope: Float64Array,
  isChannel: Uint8Array,
  roughness = DEFAULT_MANNING_N,
  bankfullDischargeM3PerS?: Float64Array,
): ChannelGeometry => {
  const n = drainageAreaM2.length
  const widthM = new Float64Array(n)
  const depthM = new Float64Array(n)
  const capacityM3PerS = new Float64Array(n)

  for (let i = 0; i < n; i++) {
    if (!isChannel[i]) continue

    const bankfull = bankfullDischargeM3PerS?.[i]
    if (bankfull !== undefined && bankfull > 0) {
      widthM[i] = bankfullWidthFromDischarge(bankfull)
      depthM[i] = bankfullDepthFromDischarge(bankfull)
      capacityM3PerS[i] = bankfull
      continue
    }

    const areaKm2 = drainageAreaM2[i]! / 1e6
    const w = bankfullWidthMetres(areaKm2)
    const d = bankfullDepthMetres(areaKm2)
    widthM[i] = w
    depthM[i] = d
    capacityM3PerS[i] = manningDischargeM3PerS(w, d, slope[i]!, roughness)
  }
  return { widthM, depthM, capacityM3PerS }
}

export interface OvertoppingSummary {
  /** Q/Qcap per channel cell; > 1 means the reach goes overbank. */
  readonly ratio: Float64Array
  readonly overtoppingCells: number
  readonly channelCells: number
  readonly maxRatio: number
  readonly maxRatioCell: number
  readonly peakDischargeM3PerS: number
}

/**
 * Compares routed discharge against bankfull capacity, reach by reach.
 *
 * The spreading model uses conveyance to decide where water actually ponds;
 * this is the diagnostic view of the same comparison — which reaches are over
 * capacity, and by how much — and it is what breach-site selection reads.
 */
export const assessOvertopping = (
  routedVolumeM3: Float64Array,
  capacityM3PerS: Float64Array,
  isChannel: Uint8Array,
  durationSeconds: number,
): OvertoppingSummary => {
  const dischargeM3PerS = new Float64Array(routedVolumeM3.length)
  for (let i = 0; i < routedVolumeM3.length; i++) {
    dischargeM3PerS[i] = routedVolumeM3[i]! / durationSeconds
  }
  return assessDischargeOvertopping(dischargeM3PerS, capacityM3PerS, isChannel)
}

/**
 * Peak-flow form of `assessOvertopping` for an unsteady hydrograph. Keeping the
 * discharge explicit prevents a short peak from being flattened back into an
 * event-average while deciding whether a defence is exceeded.
 */
export const assessDischargeOvertopping = (
  dischargeM3PerS: Float64Array,
  capacityM3PerS: Float64Array,
  isChannel: Uint8Array,
): OvertoppingSummary => {
  const n = dischargeM3PerS.length
  if (capacityM3PerS.length !== n || isChannel.length !== n) {
    throw new RangeError('discharge, capacity and channel mask must have the same length')
  }
  const ratio = new Float64Array(n)
  let overtoppingCells = 0
  let channelCells = 0
  let maxRatio = 0
  let maxRatioCell = -1
  let peakDischargeM3PerS = 0

  for (let i = 0; i < n; i++) {
    if (!isChannel[i]) continue
    channelCells++
    const discharge = dischargeM3PerS[i]!
    if (discharge > peakDischargeM3PerS) peakDischargeM3PerS = discharge
    const capacity = capacityM3PerS[i]!
    const r = capacity > 0 ? discharge / capacity : Infinity
    ratio[i] = r
    if (r > 1) overtoppingCells++
    // Ties resolved toward the larger river: a headwater ditch at 40x capacity
    // is not the reach whose failure floods a city.
    if (r > maxRatio || (r === maxRatio && capacity > (maxRatioCell >= 0 ? capacityM3PerS[maxRatioCell]! : 0))) {
      maxRatio = r
      maxRatioCell = i
    }
  }

  return { ratio, overtoppingCells, channelCells, maxRatio, maxRatioCell, peakDischargeM3PerS }
}

/**
 * Manning's n for flow across a vegetated or built floodplain.
 *
 * Chow (1959) table 5-6 puts pasture, brush and cultivated land in the
 * 0.05-0.12 range. 0.10 is the value the fluvial rating curve is solved with,
 * chosen from that range rather than from the score: swept against the four
 * hindcast events the score rises monotonically to the edge of what is
 * physical and beyond, so these events cannot identify the value and it has to
 * come from the literature. At 0.10 the compound curve is worth +1.4 points of
 * mean IoU and +8.6 of hit rate at slightly better precision — see
 * docs/specs/flood-model/plan-precision-profile.md §7.
 */
export const FLOODPLAIN_MANNING_N = 0.1

/**
 * Discharge carried by the floodplain either side of the channel, m³/s.
 *
 * Once a river is out of bank the floodplain is not a reservoir, it is part of
 * the conveyance: the flood moves downstream across it. Modelling only the
 * bankfull channel makes every valley a bathtub in a large event, which is what
 * caused this model to saturate above roughly 300 mm of rain.
 *
 * The cross-section is taken from the model's own inundation: spreading the
 * ponded area along the length of channel running through it gives an average
 * flow width, and the mean ponded depth gives its depth.
 */
export const floodplainDischargeM3PerS = (
  floodedAreaM2: number,
  channelLengthM: number,
  meanDepthM: number,
  slope: number,
  roughness = FLOODPLAIN_MANNING_N,
): number => {
  if (floodedAreaM2 <= 0 || channelLengthM <= 0 || meanDepthM <= 0) return 0
  const widthM = floodedAreaM2 / channelLengthM
  return manningDischargeM3PerS(widthM, meanDepthM, slope, roughness)
}

/** Volume a channel can carry past a cell over the event, m³. */
export const conveyanceVolumeM3 = (
  capacityM3PerS: Float64Array,
  durationSeconds: number,
): Float64Array => {
  const out = new Float64Array(capacityM3PerS.length)
  for (let i = 0; i < capacityM3PerS.length; i++) out[i] = capacityM3PerS[i]! * durationSeconds
  return out
}
