/**
 * How much of an upstream catchment's runoff can actually reach the model
 * window during the event.
 *
 * A window-limited flood model has to be told what the river brings in from
 * outside, and the naive answer — all the runoff the upstream catchment
 * generates — is badly wrong for a large basin over a short storm: a 1000 km²
 * catchment does not deliver its entire day of rain to one point in three
 * hours. Routing it properly needs a time axis this model does not have, so
 * instead the delivered volume is capped by a peak discharge derived from the
 * catchment's own response time.
 *
 * References:
 *  - Hack (1957), "Studies of longitudinal stream profiles in Virginia and
 *    Maryland", USGS Professional Paper 294-B — the length/area relation.
 *  - Kirpich (1940), "Time of concentration of small agricultural watersheds",
 *    Civil Engineering 10(6).
 *  - SCS triangular unit hydrograph: USDA-NRCS National Engineering Handbook,
 *    Part 630, Chapter 16.
 *  - Gumbel (1958), "Statistics of Extremes" — the extreme-value fit used for
 *    return levels, by method of moments.
 *  - Leclerc & Schaake (1972), "Derivation of hydrologic frequency curves",
 *    MIT Ralph M. Parsons Laboratory Report 142 — the areal reduction factor,
 *    as used in US NWS Technical Paper 29.
 */
import { estimateRunoff } from './runoff'

/** Hack's law: main-channel length in km from drainage area in km². */
export const mainChannelLengthKm = (areaKm2: number): number => 1.4 * Math.max(areaKm2, 1e-6) ** 0.6

/**
 * Kirpich time of concentration, in hours.
 *
 * Tc = 0.0195·L^0.77·S^-0.385 with L in metres and S the main-channel slope,
 * giving minutes. Kirpich was calibrated on small agricultural watersheds and
 * is applied here well beyond that range, which is part of why this is a
 * screening estimate and not a design figure.
 */
export const timeOfConcentrationHours = (lengthKm: number, channelSlope: number): number => {
  const lengthM = Math.max(lengthKm, 1e-6) * 1000
  const slope = Math.max(channelSlope, 1e-5)
  return (0.0195 * lengthM ** 0.77 * slope ** -0.385) / 60
}

/**
 * Peak discharge of the SCS triangular unit hydrograph, m³/s.
 * Qp = 0.208·A·Q/Tp, with A in km², Q the runoff depth in mm, Tp in hours.
 */
export const triangularPeakM3PerS = (
  areaKm2: number,
  runoffMm: number,
  timeToPeakHours: number,
): number => {
  if (timeToPeakHours <= 0) return 0
  return (0.208 * areaKm2 * runoffMm) / timeToPeakHours
}

export interface InflowDelivery {
  /** Volume that can reach the window during the event, m³. */
  readonly volumeM3: number
  /** Volume the catchment generates in total, m³ — the uncapped figure. */
  readonly generatedM3: number
  readonly peakDischargeM3PerS: number
  readonly timeOfConcentrationHours: number
  readonly timeToPeakHours: number
  /** volumeM3 / generatedM3: 1 means the whole catchment responds within the event. */
  readonly attenuation: number
}

/**
 * The upstream catchment's contribution at an inlet.
 *
 * The generated volume is runoff depth times catchment area. What can arrive is
 * bounded by the unit-hydrograph peak sustained over the event window — for a
 * small catchment that bound is slack and everything arrives, for a large one
 * over a short storm it is the binding constraint.
 */
export const deliverableInflow = (
  areaKm2: number,
  runoffMm: number,
  durationHours: number,
  channelSlope: number,
): InflowDelivery => {
  const generatedM3 = (runoffMm / 1000) * areaKm2 * 1e6
  const lengthKm = mainChannelLengthKm(areaKm2)
  const tcHours = timeOfConcentrationHours(lengthKm, channelSlope)
  // NEH-630-16: time to peak from the start of a rainfall excess of duration D.
  const timeToPeakHours = durationHours / 2 + 0.6 * tcHours
  const peakDischargeM3PerS = triangularPeakM3PerS(areaKm2, runoffMm, timeToPeakHours)
  const volumeM3 = Math.min(generatedM3, peakDischargeM3PerS * durationHours * 3600)

  return {
    volumeM3,
    generatedM3,
    peakDischargeM3PerS,
    timeOfConcentrationHours: tcHours,
    timeToPeakHours,
    attenuation: generatedM3 > 0 ? volumeM3 / generatedM3 : 1,
  }
}


/**
 * Return level of an annual-maximum series, by a Gumbel (EV1) fit.
 *
 * Method of moments: β = s·√6/π and μ = x̄ − 0.5772·β, then
 * x(T) = μ − β·ln(−ln(1 − 1/T)). Standard practice for flood and rainfall
 * frequency, and it needs nothing but the series itself.
 */
export const gumbelReturnLevel = (
  annualMaxima: ReadonlyArray<number>,
  returnPeriodYears: number,
): number => {
  const sample = annualMaxima.filter((v) => Number.isFinite(v) && v >= 0)
  if (sample.length < 5) {
    throw new RangeError(`a Gumbel fit needs at least 5 years, got ${sample.length}`)
  }
  if (!(returnPeriodYears > 1)) {
    throw new RangeError(`returnPeriodYears must exceed 1, got ${returnPeriodYears}`)
  }
  const n = sample.length
  const mean = sample.reduce((a, b) => a + b, 0) / n
  const variance = sample.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
  const beta = (Math.sqrt(variance) * Math.sqrt(6)) / Math.PI
  const mu = mean - 0.5772 * beta
  return mu - beta * Math.log(-Math.log(1 - 1 / returnPeriodYears))
}

/** Square miles in a square kilometre — the areal reduction factor is US-derived. */
const SQ_MILES_PER_SQ_KM = 0.3861021585424458

/**
 * Areal reduction factor: how much lower a storm's catchment average is than
 * the point value measured at a gauge.
 *
 * Rain does not fall evenly across a thousand square kilometres, so running a
 * point return level over a whole catchment overstates the volume, overstates
 * the resulting discharge, and therefore overstates the channel capacity that
 * discharge implies. Leclerc & Schaake (1972) — the form NWS TP-29 uses — needs
 * only the two things already known here, the storm duration and the area:
 *
 *   ARF = 1 − exp(−1.1·D^0.25) + exp(−1.1·D^0.25 − 0.01·A)
 *
 * with D in hours and A in square miles. It tends to 1 for a small catchment,
 * correctly — a point storm does cover a small basin — and flattens out at
 * 1 − exp(−1.1·D^0.25) for a large one, 0.912 at 24 hours.
 *
 * US-derived and applied globally, exactly like the hydraulic geometry beside
 * it; see the stated limitations.
 */
export const arealReductionFactor = (durationHours: number, areaKm2: number): number => {
  if (!(durationHours > 0) || !(areaKm2 > 0)) return 1
  const decay = 1.1 * durationHours ** 0.25
  return 1 - Math.exp(-decay) + Math.exp(-decay - 0.01 * areaKm2 * SQ_MILES_PER_SQ_KM)
}

export interface MeanAnnualFloodOptions {
  /**
   * Accumulation the return level was computed over, hours — 24 for a daily
   * series.
   */
  readonly rainfallDurationHours?: number
  /**
   * Reduce the point return level to a catchment average before running it
   * through the runoff chain. Off leaves the point value in place, which
   * overstates capacity on any catchment large enough for the storm to miss
   * part of it.
   */
  readonly arealReduction?: boolean
}

/**
 * Mean annual flood — the ~2-year peak discharge, and therefore the discharge a
 * channel is in equilibrium with.
 *
 * This is what makes a defensible bankfull capacity possible. Downstream
 * hydraulic geometry calibrated on small streams cannot be extrapolated to a
 * 5 000 km² river; the model measured its own error at two to four orders of
 * magnitude. Running the *local* 2-year rainfall through the same SCS-CN and
 * unit-hydrograph chain the rest of the model already uses gives a discharge
 * grounded in the catchment's own climate instead.
 */
export const meanAnnualFloodM3PerS = (
  areaKm2: number,
  returnLevelRainfallMm: number,
  curveNumber: number,
  channelSlope: number,
  options: MeanAnnualFloodOptions = {},
): number => {
  const { rainfallDurationHours = 24, arealReduction = false } = options
  if (!(areaKm2 > 0) || !(returnLevelRainfallMm >= 0)) return 0
  const catchmentRainfallMm = arealReduction
    ? returnLevelRainfallMm * arealReductionFactor(rainfallDurationHours, areaKm2)
    : returnLevelRainfallMm
  const runoffMm = estimateRunoff(catchmentRainfallMm, curveNumber).runoffMm
  if (runoffMm <= 0) return 0
  const tcHours = timeOfConcentrationHours(mainChannelLengthKm(areaKm2), channelSlope)
  const timeToPeakHours = rainfallDurationHours / 2 + 0.6 * tcHours
  return triangularPeakM3PerS(areaKm2, runoffMm, timeToPeakHours)
}
