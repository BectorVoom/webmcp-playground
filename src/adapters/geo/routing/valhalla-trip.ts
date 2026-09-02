import type { LineString, Position } from 'geojson'
import type { RouteManeuver, RouteStep } from '../../../domain/routing'

/**
 * Reading a Valhalla reply.
 *
 * Shared by the live adapter and the fixture provider on purpose: the fixtures are recorded
 * replies from the same engine, so parsing them with the same code is what makes fixture mode a
 * rehearsal of the live path rather than a separate one that can drift away from it.
 */

/**
 * Valhalla returns geometry as an encoded polyline at six decimal places, not five — the extra
 * digit is what keeps a path on the correct side of a street rather than in the building next to
 * it, which is the whole point of snapping to roads.
 */
export const decodePolyline6 = (encoded: string): Array<Position> => {
  const positions: Array<Position> = []
  let index = 0
  let lat = 0
  let lon = 0

  while (index < encoded.length) {
    for (const axis of ['lat', 'lon'] as const) {
      let result = 0
      let shift = 0
      let byte: number
      do {
        byte = encoded.charCodeAt(index++) - 63
        if (Number.isNaN(byte)) return positions
        result |= (byte & 0x1f) << shift
        shift += 5
      } while (byte >= 0x20)
      const delta = result & 1 ? ~(result >> 1) : result >> 1
      if (axis === 'lat') lat += delta
      else lon += delta
    }
    positions.push([lon / 1e6, lat / 1e6])
  }

  return positions
}

/**
 * Valhalla's manoeuvre vocabulary, mapped onto ours.
 *
 * The numbers are the engine's `type` field. Ramps, forks and exits collapse onto the nearest
 * plain turn: on foot they are the same physical action, and an arrow a walker cannot interpret
 * is worse than a slightly coarse one. The same goes for the vertical manoeuvres a pedestrian
 * route is full of in a city — stairs, an escalator, a station lift — which are all "keep going,
 * by this thing" and carry the engine's own wording in the instruction.
 */
const VALHALLA_MANEUVER: Record<number, RouteManeuver> = {
  1: 'depart',
  2: 'depart',
  3: 'depart',
  4: 'arrive',
  5: 'arrive',
  6: 'arrive',
  7: 'straight',
  8: 'straight',
  9: 'slight-right',
  10: 'right',
  11: 'sharp-right',
  12: 'uturn',
  13: 'uturn',
  14: 'sharp-left',
  15: 'left',
  16: 'slight-left',
  17: 'straight',
  18: 'slight-right',
  19: 'slight-left',
  20: 'slight-right',
  21: 'slight-left',
  22: 'straight',
  23: 'slight-right',
  24: 'slight-left',
  25: 'straight',
  26: 'straight',
  27: 'straight',
  28: 'straight',
  29: 'straight',
  30: 'straight',
  31: 'straight',
  32: 'straight',
  33: 'straight',
  34: 'straight',
  35: 'straight',
  36: 'straight',
  37: 'slight-right',
  38: 'slight-left',
  39: 'straight',
  40: 'straight',
  41: 'straight',
  42: 'straight',
  43: 'straight',
}

/** Absent for a type the engine added since this map was written; the turn is derived instead. */
export const toRouteManeuver = (type: number | undefined): RouteManeuver | undefined =>
  type === undefined ? undefined : VALHALLA_MANEUVER[type]

export interface ValhallaManeuver {
  readonly type?: number
  readonly instruction?: string
  readonly verbal_post_transition_instruction?: string
  readonly street_names?: ReadonlyArray<string>
  /** Kilometres, per `directions_options.units`. */
  readonly length?: number
  readonly time?: number
  readonly begin_shape_index?: number
}

export interface ValhallaLeg {
  readonly shape?: string
  readonly maneuvers?: ReadonlyArray<ValhallaManeuver>
  readonly summary?: { readonly length?: number; readonly time?: number }
}

export interface ValhallaTrip {
  readonly legs?: ReadonlyArray<ValhallaLeg>
  readonly summary?: { readonly length?: number; readonly time?: number }
  readonly status?: number
  readonly status_message?: string
}

export interface ValhallaRouteResponse {
  readonly trip?: ValhallaTrip
  /** Present when `alternates: n` was asked for; each entry wraps a whole trip of its own. */
  readonly alternates?: ReadonlyArray<{ readonly trip?: ValhallaTrip }>
  /** The server answers this shape instead when it is not in live mode. */
  readonly mode?: 'fixture' | 'live'
  readonly error?: string
  readonly message?: string
}

export interface ParsedTrip {
  readonly geometry: LineString
  readonly steps: ReadonlyArray<RouteStep>
  readonly metres: number
  readonly seconds: number
}

const KM_TO_M = 1000

const toSteps = (leg: ValhallaLeg, shape: ReadonlyArray<Position>): ReadonlyArray<RouteStep> =>
  (leg.maneuvers ?? []).map((maneuver) => {
    const beginIndex = maneuver.begin_shape_index ?? 0
    const at = shape[Math.min(beginIndex, Math.max(shape.length - 1, 0))]
    const kind = toRouteManeuver(maneuver.type)
    return {
      instruction: maneuver.instruction ?? 'Continue.',
      metres: Math.round((maneuver.length ?? 0) * KM_TO_M),
      seconds: Math.round(maneuver.time ?? 0),
      ...(maneuver.street_names && maneuver.street_names.length > 0
        ? { streetNames: maneuver.street_names }
        : {}),
      ...(kind !== undefined ? { maneuver: kind } : {}),
      ...(at ? { at: { longitude: at[0]!, latitude: at[1]! } } : {}),
    }
  })

/** `null` for a trip carrying no usable geometry, which the caller must treat as no route at all. */
export const parseTrip = (trip: ValhallaTrip | undefined): ParsedTrip | null => {
  const leg = trip?.legs?.[0]
  if (!leg?.shape) return null

  const coordinates = decodePolyline6(leg.shape)
  if (coordinates.length < 2) return null

  const summary = leg.summary ?? trip?.summary ?? {}
  return {
    geometry: { type: 'LineString', coordinates },
    steps: toSteps(leg, coordinates),
    metres: Math.round((summary.length ?? 0) * KM_TO_M),
    seconds: Math.round(summary.time ?? 0),
  }
}

/**
 * Every candidate in one reply, best first: Valhalla puts its preferred trip in `trip` and the
 * alternatives it found in `alternates`, and both are routes a person could actually walk.
 */
export const parseRouteResponse = (
  payload: ValhallaRouteResponse | undefined,
): ReadonlyArray<ParsedTrip> => {
  const trips = [payload?.trip, ...(payload?.alternates ?? []).map((a) => a.trip)]
  return trips
    .map(parseTrip)
    .filter((parsed): parsed is ParsedTrip => parsed !== null)
}
