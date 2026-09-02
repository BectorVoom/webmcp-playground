/**
 * Event timing and one-dimensional hydraulic controls for the channel network.
 *
 * The terrain grid is not a surveyed mesh and cannot support a defensible 2-D
 * shallow-water solve.  It does, however, contain a connected channel graph,
 * an event volume, and a synthetic cross-section at every reach.  This module
 * uses those quantities for the pieces a steady HAND solve necessarily misses:
 *
 *  - an SCS triangular hydrograph turns event volume into a peak and an arrival
 *    time instead of pretending the event-average discharge is the peak;
 *  - shallow-water characteristic speed (u + sqrt(g h)) carries momentum into
 *    the travel-time estimate;
 *  - a standard-step energy balance propagates subcritical downstream controls
 *    upstream, including velocity head, to represent backwater.
 *
 * This remains a screening approximation.  It is a peak-envelope calculation,
 * not a time-stepped Saint-Venant solver, and it does not resolve hydraulic
 * jumps or reverse flow.  Those limits are part of the API response.
 *
 * References:
 *  - USDA-NRCS NEH 630, chapter 16: triangular unit hydrograph.
 *  - USACE HEC-RAS Hydraulic Reference Manual: standard-step energy equation.
 *  - Bates, Horritt & Fewtrell (2010), Journal of Hydrology 387: local-inertial
 *    shallow-water formulation and gravity-wave propagation.
 */
import { mainChannelLengthKm, timeOfConcentrationHours } from './catchment'

const GRAVITY_M_PER_S2 = 9.80665
/** Area of an SCS triangular hydrograph is 1/2 Qp (2.67 Tp). */
const TRIANGULAR_VOLUME_FACTOR = 1.335
const MIN_FLOW_AREA_M2 = 1e-6
const STAGE_EPSILON_M = 1e-4
const DEFAULT_MAXIMUM_STAGE_M = 20

const assertLength = (name: string, value: ArrayLike<number>, expected: number): void => {
  if (value.length !== expected) {
    throw new RangeError(`${name} holds ${value.length} cells, grid needs ${expected}`)
  }
}

export interface FloodWaveInput {
  /** Event volume routed past every cell, m3. */
  readonly routedVolumeM3: Float64Array
  readonly drainageAreaM2: Float64Array
  readonly elevations: Float32Array
  /** Highest upstream ground draining to each cell, metres. */
  readonly headwaterElevationM: Float64Array
  readonly isChannel: Uint8Array
  readonly channelWidthM: Float64Array
  readonly channelDepthM: Float64Array
  readonly channelCapacityM3PerS: Float64Array
  readonly durationHours: number
}

export interface FloodWaveSummary {
  readonly channelCells: number
  /** First material runoff from the trunk catchment, hours after storm start. */
  readonly trunkArrivalHours: number
  readonly trunkPeakTimeHours: number
  readonly earliestArrivalHours: number
  readonly latestArrivalHours: number
  readonly peakDischargeM3PerS: number
  readonly maximumCharacteristicSpeedMPerS: number
}

export interface FloodWaveResult {
  /** Event peak at each reach, rather than event volume divided by duration. */
  readonly peakDischargeM3PerS: Float64Array
  /** Catchment lag from storm start to first material response at a reach. */
  readonly arrivalTimeHours: Float64Array
  readonly peakTimeHours: Float64Array
  /** Downstream characteristic u + sqrt(g h), m/s. */
  readonly characteristicSpeedMPerS: Float64Array
  readonly summary: FloodWaveSummary
}

/** Peak of a triangular hydrograph whose total area is `volumeM3`. */
export const triangularPeakFromVolumeM3PerS = (volumeM3: number, timeToPeakHours: number): number => {
  if (!(volumeM3 > 0) || !(timeToPeakHours > 0)) return 0
  return volumeM3 / (TRIANGULAR_VOLUME_FACTOR * timeToPeakHours * 3600)
}

/**
 * Turns each reach's routed event volume into a timed flood-wave peak.
 *
 * Kirpich/NRCS supplies a catchment lag.  The characteristic travel time is
 * also evaluated from u + sqrt(g h), the downstream characteristic of the
 * shallow-water momentum equations; the slower of the two controls.  The peak
 * is never allowed below the event-average flow because externally delivered
 * volumes have already been clipped to what can cross the window during the
 * event, and lowering their peak below their average would contradict that
 * volume budget.
 */
export const estimateFloodWave = (input: FloodWaveInput): FloodWaveResult => {
  const n = input.routedVolumeM3.length
  for (const [name, value] of [
    ['drainageAreaM2', input.drainageAreaM2],
    ['elevations', input.elevations],
    ['headwaterElevationM', input.headwaterElevationM],
    ['isChannel', input.isChannel],
    ['channelWidthM', input.channelWidthM],
    ['channelDepthM', input.channelDepthM],
    ['channelCapacityM3PerS', input.channelCapacityM3PerS],
  ] as const) assertLength(name, value, n)
  if (!(input.durationHours > 0) || !Number.isFinite(input.durationHours)) {
    throw new RangeError(`durationHours must be positive, got ${input.durationHours}`)
  }

  const peakDischargeM3PerS = new Float64Array(n)
  const arrivalTimeHours = new Float64Array(n)
  const peakTimeHours = new Float64Array(n)
  const characteristicSpeedMPerS = new Float64Array(n)

  let channelCells = 0
  let earliestArrivalHours = Infinity
  let latestArrivalHours = 0
  let peakDischarge = 0
  let maximumCharacteristicSpeed = 0
  let trunk = -1

  for (let c = 0; c < n; c++) {
    if (!input.isChannel[c]) continue
    channelCells++
    if (trunk < 0 || input.drainageAreaM2[c]! > input.drainageAreaM2[trunk]!) trunk = c

    const volumeM3 = input.routedVolumeM3[c]!
    const areaKm2 = Math.max(input.drainageAreaM2[c]! / 1e6, 1e-6)
    const channelLengthKm = mainChannelLengthKm(areaKm2)
    const reliefM = Math.max(1, input.headwaterElevationM[c]! - input.elevations[c]!)
    const basinSlope = reliefM / (channelLengthKm * 1000)
    const kirpichLagHours = 0.6 * timeOfConcentrationHours(channelLengthKm, basinSlope)
    const averageDischarge = Math.max(0, volumeM3) / (input.durationHours * 3600)

    let lagHours = kirpichLagHours
    let peakTime = input.durationHours / 2 + lagHours
    let peak = Math.max(averageDischarge, triangularPeakFromVolumeM3PerS(volumeM3, peakTime))
    let characteristicSpeed = 0

    // Peak, hydraulic depth and travel time depend weakly on one another. Two
    // fixed-point passes settle that loop without a time-stepping cost.
    for (let iteration = 0; iteration < 2; iteration++) {
      const bankfullDepth = Math.max(0.05, input.channelDepthM[c]!)
      const capacity = input.channelCapacityM3PerS[c]!
      // Manning Q ~ h^(5/3) in a wide section. This is used for wave speed only,
      // not as a second rating curve.
      const flowDepth =
        capacity > 0 && peak > capacity
          ? bankfullDepth * (peak / capacity) ** (3 / 5)
          : bankfullDepth
      const flowArea = Math.max(MIN_FLOW_AREA_M2, input.channelWidthM[c]! * flowDepth)
      const velocity = peak / flowArea
      characteristicSpeed = Math.max(0.1, velocity + Math.sqrt(GRAVITY_M_PER_S2 * flowDepth))
      const characteristicTravelHours = (channelLengthKm * 1000) / characteristicSpeed / 3600
      lagHours = Math.max(kirpichLagHours, characteristicTravelHours)
      peakTime = input.durationHours / 2 + lagHours
      peak = Math.max(averageDischarge, triangularPeakFromVolumeM3PerS(volumeM3, peakTime))
    }

    peakDischargeM3PerS[c] = peak
    arrivalTimeHours[c] = lagHours
    peakTimeHours[c] = peakTime
    characteristicSpeedMPerS[c] = characteristicSpeed
    earliestArrivalHours = Math.min(earliestArrivalHours, lagHours)
    latestArrivalHours = Math.max(latestArrivalHours, lagHours)
    peakDischarge = Math.max(peakDischarge, peak)
    maximumCharacteristicSpeed = Math.max(maximumCharacteristicSpeed, characteristicSpeed)
  }

  return {
    peakDischargeM3PerS,
    arrivalTimeHours,
    peakTimeHours,
    characteristicSpeedMPerS,
    summary: {
      channelCells,
      trunkArrivalHours: trunk >= 0 ? arrivalTimeHours[trunk]! : 0,
      trunkPeakTimeHours: trunk >= 0 ? peakTimeHours[trunk]! : 0,
      earliestArrivalHours: Number.isFinite(earliestArrivalHours) ? earliestArrivalHours : 0,
      latestArrivalHours,
      peakDischargeM3PerS: peakDischarge,
      maximumCharacteristicSpeedMPerS: maximumCharacteristicSpeed,
    },
  }
}

export interface HydraulicStageContext {
  readonly elevations: Float32Array
  readonly receivers: Int32Array
  /** Priority-Flood order: downstream receivers before their donors. */
  readonly popOrder: Int32Array
  readonly peakDischargeM3PerS: Float64Array
  readonly arrivalTimeHours: Float64Array
  readonly peakTimeHours: Float64Array
  readonly channelWidthM: Float64Array
  readonly channelDepthM: Float64Array
  readonly roughness: number
  readonly eventDurationHours: number
  readonly maximumStageM?: number
  /** Test/diagnostic switch; production uses the velocity-head term. */
  readonly includeMomentum?: boolean
}

export interface HydraulicStageSummary {
  readonly backwaterAffectedReaches: number
  readonly maximumBackwaterRiseM: number
  readonly momentumAffectedReaches: number
  readonly maximumMomentumHeadM: number
  readonly maximumVelocityMPerS: number
  readonly maximumFroudeNumber: number
  readonly supercriticalReaches: number
  readonly stageCappedReaches: number
}

export interface HydraulicStageResult {
  readonly stageM: Float64Array
  readonly summary: HydraulicStageSummary
}

interface SectionState {
  readonly flowAreaM2: Float64Array
  readonly topWidthM: Float64Array
  readonly velocityMPerS: Float64Array
  readonly froudeNumber: Float64Array
  readonly velocityHeadM: Float64Array
  readonly frictionSlope: Float64Array
}

const sectionState = (input: {
  readonly stageM: Float64Array
  readonly hand: Float32Array
  readonly nearestChannel: Int32Array
  readonly isChannel: Uint8Array
  readonly peakDischargeM3PerS: Float64Array
  readonly channelWidthM: Float64Array
  readonly channelDepthM: Float64Array
  readonly rowCellAreaM2: Float64Array
  readonly reachLengthM: number
  readonly width: number
  readonly roughness: number
  readonly includeMomentum: boolean
}): SectionState => {
  const n = input.stageM.length
  const floodplainVolumeM3 = new Float64Array(n)
  const floodplainPlanAreaM2 = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const target = input.nearestChannel[i]!
    if (target < 0 || !(input.stageM[target]! > 0)) continue
    const depth = input.stageM[target]! - input.hand[i]!
    if (depth <= 0) continue
    const cellArea = input.rowCellAreaM2[Math.floor(i / input.width)]!
    floodplainVolumeM3[target]! += depth * cellArea
    floodplainPlanAreaM2[target]! += cellArea
  }

  const flowAreaM2 = new Float64Array(n)
  const topWidthM = new Float64Array(n)
  const velocityMPerS = new Float64Array(n)
  const froudeNumber = new Float64Array(n)
  const velocityHeadM = new Float64Array(n)
  const frictionSlope = new Float64Array(n)

  for (let c = 0; c < n; c++) {
    if (!input.isChannel[c] || !(input.stageM[c]! > 0)) continue
    const bankfullWidth = Math.max(0.1, input.channelWidthM[c]!)
    const bankfullDepth = Math.max(0.05, input.channelDepthM[c]!)
    const area = Math.max(
      MIN_FLOW_AREA_M2,
      bankfullWidth * bankfullDepth + floodplainVolumeM3[c]! / input.reachLengthM,
    )
    const width = Math.max(bankfullWidth, floodplainPlanAreaM2[c]! / input.reachLengthM)
    const hydraulicDepth = area / width
    const wettedPerimeter = width + 2 * hydraulicDepth
    const hydraulicRadius = area / wettedPerimeter
    const velocity = input.peakDischargeM3PerS[c]! / area
    const froude = velocity / Math.sqrt(GRAVITY_M_PER_S2 * hydraulicDepth)
    const velocityHead = input.includeMomentum ? (velocity * velocity) / (2 * GRAVITY_M_PER_S2) : 0
    const friction =
      area > 0 && hydraulicRadius > 0
        ? (input.peakDischargeM3PerS[c]! * input.roughness /
            (area * hydraulicRadius ** (2 / 3))) ** 2
        : 0

    flowAreaM2[c] = area
    topWidthM[c] = width
    velocityMPerS[c] = velocity
    froudeNumber[c] = froude
    velocityHeadM[c] = velocityHead
    frictionSlope[c] = friction
  }
  return { flowAreaM2, topWidthM, velocityMPerS, froudeNumber, velocityHeadM, frictionSlope }
}

/** Fraction of triangular-hydrograph peak flowing at `timeHours`. */
const hydrographFraction = (
  arrivalTimeHours: number,
  peakTimeHours: number,
  timeHours: number,
): number => {
  if (timeHours < arrivalTimeHours || !(peakTimeHours > arrivalTimeHours)) return 0
  if (timeHours <= peakTimeHours) {
    return (timeHours - arrivalTimeHours) / (peakTimeHours - arrivalTimeHours)
  }
  const endTimeHours = arrivalTimeHours + 2.67 * (peakTimeHours - arrivalTimeHours)
  if (timeHours >= endTimeHours) return 0
  return (endTimeHours - timeHours) / (endTimeHours - peakTimeHours)
}

/**
 * Applies subcritical standard-step backwater to independently solved HAND
 * stages. The energy equation includes velocity head, so contractions and
 * accelerations affect the upstream stage rather than disappearing into a
 * steady normal-depth assumption.
 */
export const applyHydraulicStageEffects = (input: {
  readonly stageM: Float64Array
  readonly hand: Float32Array
  readonly nearestChannel: Int32Array
  readonly isChannel: Uint8Array
  readonly rowCellAreaM2: Float64Array
  readonly reachLengthM: number
  readonly width: number
  readonly height: number
  /** A ladder-pegged stage is a failure marker and cannot be a boundary control. */
  readonly invalidControl?: Uint8Array
  readonly context: HydraulicStageContext
}): HydraulicStageResult => {
  const n = input.width * input.height
  for (const [name, value] of [
    ['stageM', input.stageM],
    ['hand', input.hand],
    ['nearestChannel', input.nearestChannel],
    ['isChannel', input.isChannel],
    ['elevations', input.context.elevations],
    ['receivers', input.context.receivers],
    ['peakDischargeM3PerS', input.context.peakDischargeM3PerS],
    ['arrivalTimeHours', input.context.arrivalTimeHours],
    ['peakTimeHours', input.context.peakTimeHours],
    ['channelWidthM', input.context.channelWidthM],
    ['channelDepthM', input.context.channelDepthM],
  ] as const) assertLength(name, value, n)
  if (input.context.popOrder.length !== n) {
    throw new RangeError(`popOrder holds ${input.context.popOrder.length} cells, grid needs ${n}`)
  }
  if (input.rowCellAreaM2.length !== input.height) {
    throw new RangeError(
      `rowCellAreaM2 holds ${input.rowCellAreaM2.length} rows, grid needs ${input.height}`,
    )
  }
  if (input.invalidControl !== undefined) assertLength('invalidControl', input.invalidControl, n)
  if (!(input.reachLengthM > 0)) throw new RangeError('reachLengthM must be positive')
  if (!(input.context.roughness > 0)) throw new RangeError('roughness must be positive')
  if (!(input.context.eventDurationHours > 0)) throw new RangeError('eventDurationHours must be positive')

  const includeMomentum = input.context.includeMomentum ?? true
  const maximumStageM = input.context.maximumStageM ?? DEFAULT_MAXIMUM_STAGE_M
  const baseStageM = Float64Array.from(input.stageM)
  const stageM = Float64Array.from(input.stageM)
  const momentumAffected = new Uint8Array(n)
  const stageCapped = new Uint8Array(n)
  const state = sectionState({
    stageM,
    hand: input.hand,
    nearestChannel: input.nearestChannel,
    isChannel: input.isChannel,
    peakDischargeM3PerS: input.context.peakDischargeM3PerS,
    channelWidthM: input.context.channelWidthM,
    channelDepthM: input.context.channelDepthM,
    rowCellAreaM2: input.rowCellAreaM2,
    reachLengthM: input.reachLengthM,
    width: input.width,
    roughness: input.context.roughness,
    includeMomentum,
  })
  // Time belonging to the boundary that produced the envelope stage. Carrying
  // it upstream prevents pairwise-overlapping peaks from creating a transitive
  // profile whose ends never occurred at the same time.
  const controlTimeHours = Float64Array.from(input.context.peakTimeHours)

  const candidateAt = (
    c: number,
    downstream: number,
    timeHours: number,
    downstreamStageAtTimeM: number,
  ): { stageM: number; momentumDifferenceM: number } | null => {
    const upstreamFraction = hydrographFraction(
      input.context.arrivalTimeHours[c]!, input.context.peakTimeHours[c]!, timeHours,
    )
    const downstreamFraction = hydrographFraction(
      input.context.arrivalTimeHours[downstream]!,
      input.context.peakTimeHours[downstream]!,
      timeHours,
    )
    // A propagated downstream boundary can remain high after this reach's own
    // pulse; otherwise no water in either section means there is no profile.
    if (!(upstreamFraction > 0) && !(downstreamStageAtTimeM > 0)) return null
    const upstreamVelocityHeadM = state.velocityHeadM[c]! * upstreamFraction ** 2
    const downstreamVelocityHeadM = state.velocityHeadM[downstream]! * downstreamFraction ** 2
    const downstreamFroude = state.froudeNumber[downstream]! * downstreamFraction
    if (downstreamFroude >= 1) return null
    const upstreamLocalStageM = baseStageM[c]! * upstreamFraction ** (3 / 5)
    const upstreamLocalWaterSurfaceM = input.context.elevations[c]! + upstreamLocalStageM
    const downstreamWaterSurfaceM =
      input.context.elevations[downstream]! + downstreamStageAtTimeM
    // Friction alone defines a gradually varied normal profile; it is not a
    // downstream control. Backwater begins only where tailwater already stands
    // above the upstream reach's own water surface at this same time.
    if (!(downstreamWaterSurfaceM > upstreamLocalWaterSurfaceM + STAGE_EPSILON_M)) return null
    const frictionLossM =
      (state.frictionSlope[c]! * upstreamFraction ** 2 +
        state.frictionSlope[downstream]! * downstreamFraction ** 2) /
      2 * input.reachLengthM
    return {
      stageM:
        input.context.elevations[downstream]! + downstreamStageAtTimeM +
        downstreamVelocityHeadM + frictionLossM -
        input.context.elevations[c]! - upstreamVelocityHeadM,
      momentumDifferenceM: Math.abs(downstreamVelocityHeadM - upstreamVelocityHeadM),
    }
  }

  // Receivers precede donors, so a single pass carries a downstream boundary
  // and its actual time all the way upstream without mixing peak snapshots.
  for (let k = 0; k < input.context.popOrder.length; k++) {
    const c = input.context.popOrder[k]!
    if (!input.isChannel[c] || !(baseStageM[c]! > 0)) continue
    const downstream = input.context.receivers[c]!
    if (downstream < 0 || !input.isChannel[downstream] || !(baseStageM[downstream]! > 0)) continue
    if (input.invalidControl?.[downstream] === 1) continue

    const ownPeakTime = input.context.peakTimeHours[c]!
    const downstreamAtOwnPeak =
      baseStageM[downstream]! * hydrographFraction(
        input.context.arrivalTimeHours[downstream]!,
        input.context.peakTimeHours[downstream]!,
        ownPeakTime,
      ) ** (3 / 5)
    const ownPeakCandidate = candidateAt(c, downstream, ownPeakTime, downstreamAtOwnPeak)
    const boundaryTime = controlTimeHours[downstream]!
    const boundaryCandidate = candidateAt(c, downstream, boundaryTime, stageM[downstream]!)

    let chosen = ownPeakCandidate
    let chosenTime = ownPeakTime
    if (boundaryCandidate !== null && (chosen === null || boundaryCandidate.stageM > chosen.stageM)) {
      chosen = boundaryCandidate
      chosenTime = boundaryTime
    }
    if (chosen === null || !(chosen.stageM > stageM[c]! + STAGE_EPSILON_M)) continue
    if (includeMomentum && chosen.momentumDifferenceM > STAGE_EPSILON_M) momentumAffected[c] = 1
    if (chosen.stageM > maximumStageM) stageCapped[c] = 1
    stageM[c] = Math.min(maximumStageM, chosen.stageM)
    controlTimeHours[c] = chosenTime
  }

  const finalState = sectionState({
    stageM,
    hand: input.hand,
    nearestChannel: input.nearestChannel,
    isChannel: input.isChannel,
    peakDischargeM3PerS: input.context.peakDischargeM3PerS,
    channelWidthM: input.context.channelWidthM,
    channelDepthM: input.context.channelDepthM,
    rowCellAreaM2: input.rowCellAreaM2,
    reachLengthM: input.reachLengthM,
    width: input.width,
    roughness: input.context.roughness,
    includeMomentum: true,
  })

  let backwaterAffectedReaches = 0
  let maximumBackwaterRiseM = 0
  let momentumAffectedReaches = 0
  let maximumMomentumHeadM = 0
  let maximumVelocityMPerS = 0
  let maximumFroudeNumber = 0
  let supercriticalReaches = 0
  let stageCappedReaches = 0
  for (let c = 0; c < n; c++) {
    const rise = stageM[c]! - baseStageM[c]!
    if (rise > STAGE_EPSILON_M) backwaterAffectedReaches++
    maximumBackwaterRiseM = Math.max(maximumBackwaterRiseM, rise)
    if (momentumAffected[c]) momentumAffectedReaches++
    maximumMomentumHeadM = Math.max(maximumMomentumHeadM, finalState.velocityHeadM[c]!)
    maximumVelocityMPerS = Math.max(maximumVelocityMPerS, finalState.velocityMPerS[c]!)
    maximumFroudeNumber = Math.max(maximumFroudeNumber, finalState.froudeNumber[c]!)
    if (finalState.froudeNumber[c]! >= 1) supercriticalReaches++
    if (stageCapped[c]) stageCappedReaches++
  }

  return {
    stageM,
    summary: {
      backwaterAffectedReaches,
      maximumBackwaterRiseM,
      momentumAffectedReaches,
      maximumMomentumHeadM,
      maximumVelocityMPerS,
      maximumFroudeNumber,
      supercriticalReaches,
      stageCappedReaches,
    },
  }
}
