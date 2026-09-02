import type { LineString, Position } from 'geojson'
import type { LonLat } from '../../domain/geo'
import { bearingToDirection } from '../../domain/geo'
import type { RouteManeuver, RouteStep } from '../../domain/routing'

/**
 * Turn-by-turn geometry: the arithmetic that turns a polyline into the "in 200 m, turn left"
 * sequence a person can walk.
 *
 * A routing engine normally hands back manoeuvres of its own. Ours does not always — a route
 * synthesised for a destination the fixture has no recorded path to arrives as bare coordinates —
 * and an engine that does supply them may leave a step unclassified. Deriving the turn from the
 * geometry keeps the guidance consistent either way, and keeps it honest: the arrow shown always
 * matches the line drawn on the map, because both come from the same vertices.
 */

const EARTH_RADIUS_METRES = 6_371_000
const toRadians = (deg: number): number => (deg * Math.PI) / 180
const toDegrees = (rad: number): number => (rad * 180) / Math.PI

export const metresBetween = (from: LonLat, to: LonLat): number => {
  const dLat = toRadians(to.latitude - from.latitude)
  const dLon = toRadians(to.longitude - from.longitude)
  const lat1 = toRadians(from.latitude)
  const lat2 = toRadians(to.latitude)
  const a =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return EARTH_RADIUS_METRES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Initial bearing from one point to the next, 0–360 clockwise from north. */
export const bearingBetween = (from: LonLat, to: LonLat): number => {
  const lat1 = toRadians(from.latitude)
  const lat2 = toRadians(to.latitude)
  const dLon = toRadians(to.longitude - from.longitude)
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (toDegrees(Math.atan2(y, x)) + 360) % 360
}

/** Signed turn in (-180, 180]: negative is to the left, positive to the right. */
export const turnAngle = (fromBearing: number, toBearing: number): number => {
  const delta = ((toBearing - fromBearing + 540) % 360) - 180
  // -180 and 180 are the same turn; report it as a right u-turn so the sign stays meaningful.
  return delta === -180 ? 180 : delta
}

/**
 * Thresholds follow what pedestrian navigators use: anything under 20° is not worth mentioning,
 * and beyond 160° you are doubling back rather than turning.
 */
export const maneuverForTurn = (angleDegrees: number): RouteManeuver => {
  const magnitude = Math.abs(angleDegrees)
  if (magnitude >= 160) return 'uturn'
  if (magnitude < 20) return 'straight'
  const side = angleDegrees < 0 ? 'left' : 'right'
  if (magnitude < 45) return `slight-${side}` as RouteManeuver
  if (magnitude < 110) return side as RouteManeuver
  return `sharp-${side}` as RouteManeuver
}

const asLonLat = (position: Position): LonLat => ({
  longitude: position[0]!,
  latitude: position[1]!,
})

/** Drops repeated vertices, which would otherwise produce a zero-length leg with no bearing. */
const distinctVertices = (coordinates: ReadonlyArray<Position>): Array<LonLat> => {
  const out: Array<LonLat> = []
  for (const position of coordinates) {
    const point = asLonLat(position)
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) continue
    const last = out[out.length - 1]
    if (last && last.latitude === point.latitude && last.longitude === point.longitude) continue
    out.push(point)
  }
  return out
}

export interface BuildStepsOptions {
  readonly geometry: LineString
  readonly destinationName: string
  /** Engine total, when it has one; legs are scaled to it so the steps add up to the headline. */
  readonly totalMetres?: number
  readonly totalSeconds?: number
  /** Metres per second, used only when the engine gave no total duration. */
  readonly speedMetresPerSecond?: number
}

/**
 * Builds the step list for a route whose engine gave geometry but no manoeuvres.
 *
 * Legs shorter than this are folded into the one before them: a routing line often carries
 * vertices a few metres apart to trace a curve, and calling each of them out as its own
 * instruction would bury the turns that matter.
 */
const MIN_LEG_METRES = 25

export const buildTurnByTurnSteps = (options: BuildStepsOptions): ReadonlyArray<RouteStep> => {
  const { geometry, destinationName, totalMetres, totalSeconds, speedMetresPerSecond = 1.3 } = options
  const vertices = distinctVertices(geometry.coordinates)

  if (vertices.length < 2) return []

  const legs: Array<{ from: LonLat; to: LonLat; metres: number; bearing: number }> = []
  for (let i = 0; i < vertices.length - 1; i++) {
    const from = vertices[i]!
    const to = vertices[i + 1]!
    const metres = metresBetween(from, to)
    const bearing = bearingBetween(from, to)
    const previous = legs[legs.length - 1]
    // Merge a short wobble into the leg before it, keeping the earlier leg's heading.
    if (previous && metres < MIN_LEG_METRES) {
      previous.metres += metres
      previous.to = to
      continue
    }
    legs.push({ from, to, metres, bearing })
  }

  const rawTotal = legs.reduce((sum, leg) => sum + leg.metres, 0)
  const scale = totalMetres !== undefined && rawTotal > 0 ? totalMetres / rawTotal : 1
  const totalDuration =
    totalSeconds ?? (totalMetres ?? rawTotal) / Math.max(speedMetresPerSecond, 0.1)

  const steps: Array<RouteStep> = []
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!
    const metres = Math.round(leg.metres * scale)
    const share = rawTotal > 0 ? leg.metres / rawTotal : 1 / legs.length
    const seconds = Math.round(totalDuration * share)
    const maneuver: RouteManeuver =
      i === 0 ? 'depart' : maneuverForTurn(turnAngle(legs[i - 1]!.bearing, leg.bearing))

    steps.push({
      instruction: instructionFor(maneuver, leg.bearing, metres),
      metres,
      seconds,
      maneuver,
      at: leg.from,
    })
  }

  const last = vertices[vertices.length - 1]!
  steps.push({
    instruction: `Arrive at ${destinationName}.`,
    metres: 0,
    seconds: 0,
    maneuver: 'arrive',
    at: last,
  })

  return steps
}

const TURN_WORD: Record<RouteManeuver, string> = {
  depart: 'Head',
  straight: 'Continue straight',
  'slight-left': 'Bear left',
  left: 'Turn left',
  'sharp-left': 'Turn sharply left',
  'slight-right': 'Bear right',
  right: 'Turn right',
  'sharp-right': 'Turn sharply right',
  uturn: 'Make a U-turn',
  arrive: 'Arrive',
}

const instructionFor = (maneuver: RouteManeuver, bearing: number, metres: number): string =>
  maneuver === 'depart'
    ? `Head ${bearingToDirection(bearing)} for ${metres} m.`
    : `${TURN_WORD[maneuver]} and continue for ${metres} m.`

/**
 * Fills in manoeuvres an engine left unclassified, matching each step to the leg it covers.
 *
 * Engine steps carry distances but not always a turn or a position, so walk the geometry in step
 * order and take the manoeuvre from the vertex each step starts at.
 */
export const withDerivedManeuvers = (
  steps: ReadonlyArray<RouteStep>,
  geometry: LineString,
): ReadonlyArray<RouteStep> => {
  if (steps.length === 0) return steps
  if (steps.every((step) => step.maneuver !== undefined && step.at !== undefined)) return steps

  const vertices = distinctVertices(geometry.coordinates)
  if (vertices.length < 2) return steps

  const bearings = vertices
    .slice(0, -1)
    .map((from, i) => bearingBetween(from, vertices[i + 1]!))

  let travelled = 0
  const totalStepMetres = steps.reduce((sum, step) => sum + step.metres, 0)
  const cumulative: Array<number> = [0]
  for (let i = 0; i < vertices.length - 1; i++) {
    cumulative.push(cumulative[i]! + metresBetween(vertices[i]!, vertices[i + 1]!))
  }
  const geometryLength = cumulative[cumulative.length - 1]!
  const scale = totalStepMetres > 0 && geometryLength > 0 ? geometryLength / totalStepMetres : 1

  return steps.map((step, index) => {
    const along = travelled * scale
    travelled += step.metres

    // The vertex this step starts at: the last one at or before the distance travelled so far.
    let vertexIndex = 0
    while (vertexIndex + 1 < cumulative.length && cumulative[vertexIndex + 1]! <= along) {
      vertexIndex++
    }

    const isLast = index === steps.length - 1
    const maneuver: RouteManeuver =
      step.maneuver ??
      (index === 0
        ? 'depart'
        : isLast && step.metres === 0
          ? 'arrive'
          : vertexIndex > 0 && vertexIndex < bearings.length
            ? maneuverForTurn(turnAngle(bearings[vertexIndex - 1]!, bearings[vertexIndex]!))
            : 'straight')

    return { ...step, maneuver, at: step.at ?? vertices[vertexIndex]! }
  })
}
