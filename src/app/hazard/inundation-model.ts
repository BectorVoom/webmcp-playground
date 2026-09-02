/**
 * The modelled inundation estimate, on its way to the map.
 *
 * `/api/geo/flood-model` computes an extent from terrain, rainfall and channel capacity. Until now
 * nothing in the browser called it: the route existed, the hindcast harness scored it, and the map
 * never showed it. This is the path between the two, and it has two jobs beyond fetching.
 *
 * **It simplifies.** Real output is 31 000 to 68 000 vertices for a 20 km query — the extent is
 * vectorised from a raster, and shallow water is speckle, so the shallow band alone can be five
 * thousand disjoint parts. The rendered-layer budget is 20 000 (`MAP_VERTEX_BUDGET`, N5). Handing
 * the raw geometry to MapLibre is how you get a map that stops responding rather than one that
 * draws slowly.
 *
 * **It says what the thing is.** This is a screening model, not a hazard map anybody stands
 * behind, and it over-predicts area by design — measured 1.4–2.1× against surveyed English floods
 * and 3–12× in Japan. The summary leads with that, because a polygon on a map does not carry its
 * own provenance and a reader who confuses this with GSI or FEMA has been misled by us.
 */
import { Effect } from 'effect'
import type { FeatureCollection } from 'geojson'
import type { FloodZone } from '../../domain/hazard'
import { ToolExecutionError } from '../../domain/errors'
import { fitZonesToMapBudget, MAP_VERTEX_BUDGET } from '../../lib/geometry/simplify'

const API_URL = '/api/geo/flood-model'

export interface InundationModelRequest {
  readonly at: { readonly latitude: number; readonly longitude: number }
  readonly radiusKm: number
  readonly rainfallMm?: number
  readonly durationHours?: number
  readonly signal?: AbortSignal
}

export interface InundationModelResult {
  readonly zones: ReadonlyArray<FloodZone>
  readonly floodedAreaKm2: number
  readonly designEvent: string
  readonly verticesIn: number
  readonly verticesOut: number
  /** Disjoint polygons before and after trimming, and the mapped area trimming cost. */
  readonly partsIn: number
  readonly partsOut: number
  readonly areaDroppedKm2: number
  readonly attributions: ReadonlyArray<string>
  readonly limitations: ReadonlyArray<string>
  /** Which best-effort inputs resolved, so a degraded run can be said to be degraded. */
  readonly inputs: ReadonlyArray<{ readonly name: string; readonly status: string }>
}

interface ModelResponse {
  readonly inundation?: {
    readonly zones?: ReadonlyArray<FloodZone>
    readonly floodedAreaKm2?: number
  }
  readonly climatology?: { readonly status?: string }
  readonly defences?: { readonly status?: string }
  readonly permanentWater?: { readonly status?: string }
  readonly limitations?: ReadonlyArray<string>
}

const statusOf = (value: { readonly status?: string } | undefined): string =>
  typeof value?.status === 'string' ? value.status : 'unknown'

/**
 * Asks the route, then trims the answer to something a GPU will accept.
 *
 * The vertex counts are kept and reported rather than discarded: simplification moves the extent,
 * and a reader comparing this against a scored figure needs to know the geometry on screen is not
 * the geometry that was measured.
 */
export const fetchInundationModel = (
  request: InundationModelRequest,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Effect.Effect<InundationModelResult, ToolExecutionError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(API_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            at: { latitude: request.at.latitude, longitude: request.at.longitude },
            radiusKm: request.radiusKm,
            rainfallMm: request.rainfallMm,
            durationHours: request.durationHours,
          }),
          signal: request.signal,
        }),
      catch: (err) =>
        new ToolExecutionError({
          tool: 'disaster.inundation_model',
          message: `Could not reach the flood model: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        }),
    })

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (err) =>
        new ToolExecutionError({
          tool: 'disaster.inundation_model',
          message: `Could not read the flood model's reply: ${String(err)}`,
          cause: err,
        }),
    })

    if (!response.ok) {
      return yield* Effect.fail(
        new ToolExecutionError({
          tool: 'disaster.inundation_model',
          message: `The flood model answered HTTP ${response.status}: ${text.slice(0, 300)}`,
        }),
      )
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as ModelResponse,
      catch: () =>
        new ToolExecutionError({
          tool: 'disaster.inundation_model',
          message: `The flood model returned a body that is not JSON: ${text.slice(0, 200)}`,
        }),
    })

    const zones = parsed.inundation?.zones ?? []
    const fitted = fitZonesToMapBudget(zones, MAP_VERTEX_BUDGET)

    const attributions = Array.from(
      new Set(zones.map((zone) => zone.provenance?.attribution).filter((a): a is string => Boolean(a))),
    )
    const designEvent = zones.find((z) => z.kind?.kind === 'scenario')?.kind as
      | { readonly designEvent?: string }
      | undefined

    return {
      zones: fitted.zones,
      floodedAreaKm2: parsed.inundation?.floodedAreaKm2 ?? 0,
      designEvent: designEvent?.designEvent ?? 'design storm',
      verticesIn: fitted.verticesIn,
      verticesOut: fitted.verticesOut,
      partsIn: fitted.partsIn,
      partsOut: fitted.partsOut,
      areaDroppedKm2: fitted.areaDroppedKm2,
      attributions,
      limitations: parsed.limitations ?? [],
      inputs: [
        { name: 'rainfall climatology', status: statusOf(parsed.climatology) },
        { name: 'embankments', status: statusOf(parsed.defences) },
        { name: 'standing water', status: statusOf(parsed.permanentWater) },
      ],
    }
  })

/** The GeoJSON the `inundation-model` layer is drawn from. */
export const inundationToFeatureCollection = (
  zones: ReadonlyArray<FloodZone>,
): FeatureCollection => ({
  type: 'FeatureCollection',
  features: zones.map((zone) => ({
    type: 'Feature' as const,
    geometry: zone.geometry,
    properties: {
      id: zone.id,
      hazardClass: zone.hazardClass,
      kind: zone.kind.kind,
      depth: zone.depth,
      // Carried on the feature because the layer is not the only thing that reads it, and because
      // a polygon that cannot say it is modelled is a polygon that will be read as surveyed.
      modelled: true,
    },
  })),
})

/**
 * What the reader is told.
 *
 * Leads with the disclaimer rather than the number. The area is the eye-catching part and the
 * least trustworthy: it is over-predicted several-fold by construction, and a summary that opens
 * with "58.3 km² flooded" invites it to be quoted as a finding.
 */
export const summariseInundationModel = (options: {
  readonly result: InundationModelResult
  readonly radiusKm: number
  readonly dataMode: 'live' | 'fixture'
}): string => {
  const { result, radiusKm, dataMode } = options
  const degraded = result.inputs.filter((i) => i.status !== 'ok')

  const lines = [
    'MODELLED INUNDATION ESTIMATE — not an official hazard map, and not a forecast.',
    dataMode === 'fixture' ? 'SIMULATED DATA — NOT REAL (fixture mode)' : '',
    `This is what this system's own terrain model makes of a ${result.designEvent}. It is a ` +
      `screening estimate that over-predicts flooded area several-fold by construction ` +
      `(measured 1.4–2.1× against surveyed English floods, 3–12× in Japan). Where an authority ` +
      `publishes a hazard map — GSI, FEMA, Copernicus — that map governs, not this.`,
    '',
    `Modelled extent: ${result.floodedAreaKm2.toFixed(1)} km² within ${radiusKm} km, in ` +
      `${result.zones.length} depth band(s).`,
    result.verticesOut < result.verticesIn
      ? `Geometry reduced for display: ${result.verticesIn.toLocaleString()} → ` +
        `${result.verticesOut.toLocaleString()} vertices, so the drawn outline is coarser than the ` +
        `modelled one.`
      : `Geometry drawn unreduced (${result.verticesOut.toLocaleString()} vertices).`,
    // Dropped fragments are real modelled water, so the loss is stated rather than absorbed into
    // the word "simplified". Most of it is speckle a pixel wide; some of it may not be.
    result.partsOut < result.partsIn
      ? `${(result.partsIn - result.partsOut).toLocaleString()} of ${result.partsIn.toLocaleString()} ` +
        `separate patches were too small to draw and are not shown ` +
        `(${result.areaDroppedKm2.toFixed(1)} km², ` +
        `${((result.areaDroppedKm2 / Math.max(result.floodedAreaKm2, 1e-9)) * 100).toFixed(1)}% of ` +
        `the modelled extent). The largest patch of every depth band is always kept.`
      : '',
    `Map: layer 'inundation-model' updated (${result.zones.length} features).`,
    degraded.length > 0
      ? `Degraded inputs — treat the extent with extra caution: ${degraded
          .map((i) => `${i.name} (${i.status})`)
          .join(', ')}.`
      : '',
    '',
    ...result.limitations.map((limitation) => `- ${limitation}`),
    result.attributions.length > 0 ? `Attribution: ${result.attributions.join('; ')}` : '',
  ]

  return lines.filter((line) => line !== '').join('\n')
}
