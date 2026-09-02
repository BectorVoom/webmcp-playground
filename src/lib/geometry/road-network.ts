import type { LineString } from 'geojson'
import { metresBetween } from './directions'

export type RoadAdherenceReason =
  | 'road-shaped'
  | 'short-enough-for-one-segment'
  | 'degenerate'
  | 'crow-flight'
  | 'too-few-shape-points'
  | 'shape-points-too-sparse'

export interface RoadAdherenceReport {
  readonly followsRoadNetwork: boolean
  readonly reason: RoadAdherenceReason
  readonly lengthMetres: number
  readonly vertexCount: number
  /** Mean spacing of shape points. A routed path puts one at every node of every way it uses. */
  readonly metresPerVertex: number
  /** Path length over the crow-flight distance. Exactly 1 for a line drawn between the endpoints. */
  readonly detourRatio: number
}

/**
 * Under this a single straight segment is a plausible thing for an engine to return — crossing a
 * forecourt, or the last few metres to a door — so shape alone cannot condemn it.
 */
const SHORT_ROUTE_METRES = 60

/**
 * A routed path bends: it takes a junction, follows a kerb, rounds a corner. Four points is the
 * most an L-shaped approximation produces, so five is the first count no hand-drawn shortcut
 * reaches.
 */
const MIN_SHAPE_VERTICES = 5

/**
 * Even a long straight avenue carries side roads, crossings and kerb geometry, so a routed shape
 * point lands far more often than this. A synthesised path spans hundreds of metres per point.
 */
const MAX_METRES_PER_VERTEX = 200

/**
 * Decides whether a polyline has the shape of something traced along streets (R3.1).
 *
 * This is a check on geometry, not on provenance: it is what lets an adapter refuse to pass off a
 * crow-flight as a routed path, and what lets a test assert that what reaches the map really does
 * follow roads. It answers "could this have come off a road network", not "which roads" — that
 * would need the network itself, which the client does not hold.
 */
export const assessRoadAdherence = (geometry: LineString): RoadAdherenceReport => {
  const coordinates = geometry.coordinates
  const vertexCount = coordinates.length

  if (vertexCount < 2) {
    return {
      followsRoadNetwork: false,
      reason: 'degenerate',
      lengthMetres: 0,
      vertexCount,
      metresPerVertex: 0,
      detourRatio: 1,
    }
  }

  let lengthMetres = 0
  for (let i = 0; i < vertexCount - 1; i++) {
    const from = coordinates[i]!
    const to = coordinates[i + 1]!
    lengthMetres += metresBetween(
      { longitude: from[0]!, latitude: from[1]! },
      { longitude: to[0]!, latitude: to[1]! },
    )
  }

  const start = coordinates[0]!
  const end = coordinates[vertexCount - 1]!
  const crowFlightMetres = metresBetween(
    { longitude: start[0]!, latitude: start[1]! },
    { longitude: end[0]!, latitude: end[1]! },
  )
  const detourRatio = crowFlightMetres > 0 ? lengthMetres / crowFlightMetres : 1
  const metresPerVertex = lengthMetres / (vertexCount - 1)

  const report = { lengthMetres, vertexCount, metresPerVertex, detourRatio }

  if (lengthMetres === 0) {
    return { ...report, followsRoadNetwork: false, reason: 'degenerate' }
  }

  if (lengthMetres < SHORT_ROUTE_METRES) {
    return { ...report, followsRoadNetwork: true, reason: 'short-enough-for-one-segment' }
  }

  if (vertexCount === 2) {
    return { ...report, followsRoadNetwork: false, reason: 'crow-flight' }
  }

  if (vertexCount < MIN_SHAPE_VERTICES) {
    return { ...report, followsRoadNetwork: false, reason: 'too-few-shape-points' }
  }

  if (metresPerVertex > MAX_METRES_PER_VERTEX) {
    return { ...report, followsRoadNetwork: false, reason: 'shape-points-too-sparse' }
  }

  return { ...report, followsRoadNetwork: true, reason: 'road-shaped' }
}

/** A reason a reader — or a log line — can act on, rather than a bare enum member. */
export const describeRoadAdherence = (report: RoadAdherenceReport): string => {
  switch (report.reason) {
    case 'road-shaped':
      return `Follows the road network: ${report.vertexCount} shape points, one every ${Math.round(report.metresPerVertex)} m.`
    case 'short-enough-for-one-segment':
      return `Too short (${Math.round(report.lengthMetres)} m) for its shape to say either way; accepted as routed.`
    case 'degenerate':
      return 'Not a path: fewer than two distinct points.'
    case 'crow-flight':
      return `A straight line between the endpoints (${Math.round(report.lengthMetres)} m, 2 points), not a route along streets.`
    case 'too-few-shape-points':
      return `Only ${report.vertexCount} shape points over ${Math.round(report.lengthMetres)} m — an approximation, not a routed path.`
    case 'shape-points-too-sparse':
      return `Shape points every ${Math.round(report.metresPerVertex)} m over ${Math.round(report.lengthMetres)} m — too sparse to have been traced along streets.`
  }
}

/** Convenience for the common question, when the reason is not needed. */
export const followsRoadNetwork = (geometry: LineString): boolean =>
  assessRoadAdherence(geometry).followsRoadNetwork
