import { Effect, Schema } from 'effect'
import { textResult, type ToolSet } from '../domain/tool'
import { ToolExecutionError } from '../domain/errors'
import { clampRadius, roundCoordsForOutbound, type LonLat, type ResolvedLocation } from '../domain/geo'
import { describeGeoError, remedyForGeoError } from '../domain/geo-errors'
import { isAmbiguous, normalisePlaceQuery, type GeocodedPlace } from '../domain/geocoding'
import { resolveRegion } from '../adapters/geo/region'
import { getGeocoderForMode, getRegistryForMode } from '../adapters/geo/registry'
import { BrowserGeolocationAdapter } from '../adapters/geo/browser-geolocation'
import { setGsiTileCap } from '../adapters/geo/jp/flood'
import { defaultMapPort } from '../adapters/map/memory-map'
import type { GeolocationPort } from '../ports/Geolocation'
import type { MapPort } from '../ports/Map'
import { buildHazardSnapshot } from '../app/hazard/snapshot'
import {
  fetchInundationModel,
  inundationToFeatureCollection,
  summariseInundationModel,
} from '../app/hazard/inundation-model'
import { findFacilitiesByName, planEvacuationRoutes } from '../app/hazard/routing-service'
import { createCirclePolygon } from '../lib/geometry/circle'
import {
  summariseAlerts,
  summariseFlood,
  summariseGeocode,
  summarisePlaces,
  summariseRoutes,
} from '../app/hazard/summarise'
import type { FeatureCollection } from 'geojson'

export let currentGeolocationPort: GeolocationPort = new BrowserGeolocationAdapter()
export let currentMapPort: MapPort = defaultMapPort
export let currentDataMode: 'live' | 'fixture' = 'fixture'
/** Routing is resolved separately from the hazard data; see `ServerConfig.routingMode`. */
export let currentRoutingMode: 'live' | 'fixture' = 'fixture'

interface ServerModes {
  readonly dataMode: 'live' | 'fixture'
  readonly routingMode: 'live' | 'fixture'
}

/** An explicit choice wins over what the server reports, for tests and the debug handle. */
let pinnedDataMode: 'live' | 'fixture' | undefined
let modeProbe: Promise<ServerModes> | undefined

/**
 * Pins both modes together: a test that asks for fixture data wants a hermetic run, and live
 * routing would put a network call in the middle of it.
 */
export const setDisasterDataMode = (mode: 'live' | 'fixture'): void => {
  pinnedDataMode = mode
  currentDataMode = mode
  currentRoutingMode = mode
}

/** Forgets both the pin and the cached probe, so a test starts from a clean slate. */
export const resetDisasterDataMode = (): void => {
  pinnedDataMode = undefined
  modeProbe = undefined
  currentDataMode = 'fixture'
  currentRoutingMode = 'fixture'
}

/**
 * Adopts the data mode the server is actually running in.
 *
 * The server owns this decision: it holds the allow-list and the only network path to an upstream,
 * so a client that assumed `live` would simply fail every call. Without asking, the client stayed
 * on fixtures for ever and the live providers — the real routing engine among them — could never
 * be reached, whatever the server was configured to do. Probed once and cached; anything that goes
 * wrong means fixtures, which always work.
 */
const resolveDataMode = Effect.promise(async (): Promise<ServerModes> => {
  if (pinnedDataMode !== undefined) {
    return { dataMode: pinnedDataMode, routingMode: pinnedDataMode }
  }
  modeProbe ??= (async (): Promise<ServerModes> => {
    const offline: ServerModes = { dataMode: 'fixture', routingMode: 'fixture' }
    try {
      const response = await fetch('/api/geo/providers')
      if (!response.ok) return offline
      const body = (await response.json()) as {
        dataMode?: unknown
        routingMode?: unknown
        tileCap?: unknown
      }
      if (typeof body.tileCap === 'number') setGsiTileCap(body.tileCap)
      return {
        dataMode: body.dataMode === 'live' ? 'live' : 'fixture',
        // A server too old to report one routed on the data mode, which is what it would have done.
        routingMode:
          body.routingMode === 'live'
            ? 'live'
            : body.routingMode === 'fixture'
              ? 'fixture'
              : body.dataMode === 'live'
                ? 'live'
                : 'fixture',
      }
    } catch {
      return offline
    }
  })()
  const modes = await modeProbe
  currentDataMode = modes.dataMode
  currentRoutingMode = modes.routingMode
  return modes
})

export const setDisasterGeolocationPort = (port: GeolocationPort): void => {
  currentGeolocationPort = port
}

export const setDisasterMapPort = (port: MapPort): void => {
  currentMapPort = port
}

export const emitUserPositionLayer = (
  loc: ResolvedLocation,
  radiusKm?: number,
): Effect.Effect<void, never> => {
  const userGeojson: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [loc.coordinates.longitude, loc.coordinates.latitude],
        },
        properties: { accuracy: loc.accuracyMetres, source: loc.source, title: 'Your Location' },
      },
    ],
  }

  return Effect.gen(function* () {
    yield* currentMapPort.setLayer('user-position', userGeojson)
    if (radiusKm && radiusKm > 0) {
      const radiusPoly = createCirclePolygon(loc.coordinates, radiusKm)
      const radiusGeojson: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: radiusPoly,
            properties: { radiusKm },
          },
        ],
      }
      yield* currentMapPort.setLayer('query-radius', radiusGeojson)
    }
  })
}

const resolveOrUseLocation = (
  tool: string,
  inputCoords?: { latitude?: number; longitude?: number },
): Effect.Effect<ResolvedLocation, ToolExecutionError> =>
  Effect.gen(function* () {
    let loc: ResolvedLocation
    if (
      inputCoords?.latitude !== undefined &&
      inputCoords?.longitude !== undefined &&
      Number.isFinite(inputCoords.latitude) &&
      Number.isFinite(inputCoords.longitude)
    ) {
      const rawLoc: LonLat = {
        latitude: inputCoords.latitude,
        longitude: inputCoords.longitude,
      }
      const rounded = roundCoordsForOutbound(rawLoc)
      loc = {
        coordinates: rounded,
        accuracyMetres: 10,
        source: 'explicit',
        resolvedAt: Date.now(),
      }
    } else {
      loc = yield* currentGeolocationPort.getCurrentPosition().pipe(
        Effect.mapError(
          (err) =>
            new ToolExecutionError({
              tool,
              // The app already knows how to explain every geo error and what to do about it;
              // `err.message` alone is often absent (InsecureContext carries none) or is the
              // browser's bare "User denied Geolocation", which tells the model nothing it can act on.
              message: `${describeGeoError(err)} ${remedyForGeoError(err)}`,
              cause: err,
            }),
        ),
      )
    }

    yield* emitUserPositionLayer(loc)
    return loc
  })

/**
 * What the model is told about the optional coordinates.
 *
 * Without this the coordinates read as information the model must obtain, so a small local model
 * answers "please provide your latitude and longitude" instead of calling the tool — the device's
 * position is never consulted and the user is asked to do geodesy by hand. Measured on
 * gemma4:e2b: bare fields produced a request for coordinates on half the natural prompts
 * ("Am I in a flood zone?", "近くの避難所を教えて"); with this wording the tool was called every time.
 */
const USES_CURRENT_LOCATION =
  " Omit latitude and longitude to use the device's current location — never guess coordinates." +
  ' If the user asked about a named place rather than where they are, call disaster.geocode first and pass the coordinates it returns.'

const OPTIONAL_LATITUDE =
  "Optional latitude in WGS84. Omit it (along with longitude) to use the device's current location; set it only when the user named a specific place."

const OPTIONAL_LONGITUDE =
  "Optional longitude in WGS84. Omit it (along with latitude) to use the device's current location; set it only when the user named a specific place."

const ALERT_OPTIONAL_LATITUDE =
  "Optional explicit latitude in WGS84. Omit it when placeName is set. If neither a placeName nor coordinates were supplied, omit it to use the device's current location; never ask the user for it."

const ALERT_OPTIONAL_LONGITUDE =
  "Optional explicit longitude in WGS84. Omit it when placeName is set. If neither a placeName nor coordinates were supplied, omit it to use the device's current location; never ask the user for it."

const canonicalAlertPlaceName = (placeName: string): string => {
  const normalised = normalisePlaceQuery(placeName)
  // "Tugaru" is a common transliteration/spelling of 津軽. Nominatim does not correct it, and a
  // failed correction here would send a small model back to asking the user for coordinates.
  if (/^t(?:s)?ugaru(?: (?:area|region))?$/.test(normalised)) {
    return 'Tsugaru, Aomori, Japan'
  }
  return placeName
}

interface AlertLocation {
  readonly location: ResolvedLocation
  readonly matchedPlace?: GeocodedPlace
}

const resolveAlertLocation = (
  input: { readonly placeName?: string; readonly latitude?: number; readonly longitude?: number },
  signal: AbortSignal,
): Effect.Effect<AlertLocation, ToolExecutionError> =>
  Effect.gen(function* () {
    const placeName = input.placeName?.trim() ?? ''
    if (placeName === '') {
      return {
        location: yield* resolveOrUseLocation('disaster.official_alerts', input),
      }
    }

    const modes = yield* resolveDataMode
    const result = yield* getGeocoderForMode(modes.dataMode)
      .search({ text: canonicalAlertPlaceName(placeName), limit: 3, signal })
      .pipe(
        Effect.mapError(
          (err) =>
            new ToolExecutionError({
              tool: 'disaster.official_alerts',
              message: `Could not resolve the named alert area "${placeName}": ${describeGeoError(err)} ${remedyForGeoError(err)}`,
              cause: err,
            }),
        ),
      )

    const best = result.matches[0]
    if (best === undefined) {
      return yield* Effect.fail(
        new ToolExecutionError({
          tool: 'disaster.official_alerts',
          message:
            `No place matched "${placeName}". Retry with the prefecture/state or country included; ` +
            'do not ask the user to look up latitude and longitude.',
        }),
      )
    }
    if (isAmbiguous(result.matches)) {
      return yield* Effect.fail(
        new ToolExecutionError({
          tool: 'disaster.official_alerts',
          message: `The alert area "${placeName}" is ambiguous: ${result.matches.map((match) => match.displayName).join('; ')}. Ask which named place they mean, not for coordinates.`,
        }),
      )
    }

    return {
      location: {
        coordinates: roundCoordsForOutbound(best.at),
        accuracyMetres: best.kind === 'area' ? 50_000 : 100,
        source: 'explicit',
        resolvedAt: Date.now(),
      },
      matchedPlace: best,
    }
  })

// Bounds are part of the published JSON Schema, not prose alone. Agents can then produce valid
// calls on the first attempt, and hostile/buggy callers are rejected before an expensive provider
// request starts. Runtime clamping remains for direct internal calls that bypass the ToolRunner.
const LATITUDE = Schema.Number.pipe(Schema.between(-90, 90))
const LONGITUDE = Schema.Number.pipe(Schema.between(-180, 180))
const RADIUS_KM = Schema.Number.pipe(Schema.between(1, 20))
const RESULT_LIMIT = Schema.Number.pipe(Schema.int(), Schema.between(1, 10))
const HORIZON_HOURS = Schema.Number.pipe(Schema.between(1, 120))
const RAINFALL_MM = Schema.Number.pipe(Schema.between(0, 2000))
const DURATION_HOURS = Schema.Number.pipe(Schema.between(1, 168))

export const disasterToolSet: ToolSet = {
  id: 'disaster',
  title: 'Disaster Safety',
  description:
    'Authoritative flood zone forecasting, emergency shelter locator, official weather alerts, and evacuation route planning for US, Europe, and Japan.',
  tools: [
    // 1. disaster.locate
    {
      name: 'disaster.locate',
      title: 'Locate user position',
      description:
        "Get the user's current position from the device, returning coordinates, accuracy, source, and region. Takes no arguments: call it whenever you need the user's location instead of asking them for coordinates.",
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (_input, _ctx) =>
        Effect.gen(function* () {
          const loc = yield* resolveOrUseLocation('disaster.locate')
          const regionRes = yield* resolveRegion(loc.coordinates).pipe(
            Effect.mapError(
              (err) =>
                new ToolExecutionError({
                  tool: 'disaster.locate',
                  message: `Region unsupported for (${loc.coordinates.latitude}, ${loc.coordinates.longitude}). Supported regions: US, Europe, Japan.`,
                  cause: err,
                }),
            ),
          )

          // Update user position on map
          const userGeojson: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: {
                  type: 'Point',
                  coordinates: [loc.coordinates.longitude, loc.coordinates.latitude],
                },
                properties: { accuracy: loc.accuracyMetres, source: loc.source },
              },
            ],
          }
          yield* currentMapPort.setLayer('user-position', userGeojson)

          const text = [
            `LOCATION RESOLVED — decision support only. Follow instructions from ${regionRes.rule.authority}.`,
            currentDataMode === 'fixture' ? 'SIMULATED DATA — NOT REAL (fixture mode)' : '',
            `Coordinates: ${loc.coordinates.latitude.toFixed(4)}, ${loc.coordinates.longitude.toFixed(4)} (±${Math.round(loc.accuracyMetres)} m, ${loc.source})`,
            `Region: ${regionRes.rule.name} (${regionRes.region.toUpperCase()})`,
            `Authority: ${regionRes.rule.authority}`,
            `Map: layer 'user-position' updated (1 marker)`,
          ]
            .filter(Boolean)
            .join('\n')

          return textResult(text)
        }),
    },

    // 2. disaster.geocode
    {
      name: 'disaster.geocode',
      title: 'Find coordinates for a place name',
      description:
        'Turn a place name into latitude and longitude — "Fukui Station", "福井駅", "Berlin Hauptbahnhof", "San Francisco City Hall". ' +
        'Call this first whenever the user asks about a named place rather than where they are, then pass the coordinates it returns to the other disaster tools. ' +
        'Never invent coordinates for a place name.',
      inputSchema: Schema.Struct({
        query: Schema.String.annotations({
          description:
            'The place name as the user said it, in any language. Add the town or country to disambiguate ("Springfield, Illinois"). Never coordinates.',
        }),
        limit: Schema.optional(
          RESULT_LIMIT.annotations({
            description: 'How many candidate places to return (1-10, default 5).',
          }),
        ),
        nearLatitude: Schema.optional(
          LATITUDE.annotations({
            description:
              'Optional latitude to bias results towards, for a name that occurs in many places. A hint only — matches elsewhere are still returned.',
          }),
        ),
        nearLongitude: Schema.optional(
          LONGITUDE.annotations({ description: 'Optional longitude to bias results towards.' }),
        ),
      }),
      // OSM place names are contributed by the public, and reach the model verbatim.
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, ctx) =>
        Effect.gen(function* () {
          const query = input.query?.trim() ?? ''
          if (query === '') {
            return yield* Effect.fail(
              new ToolExecutionError({
                tool: 'disaster.geocode',
                message:
                  'No place name was given. Pass the name the user actually said, such as "Fukui Station".',
              }),
            )
          }

          const near =
            input.nearLatitude !== undefined &&
            input.nearLongitude !== undefined &&
            Number.isFinite(input.nearLatitude) &&
            Number.isFinite(input.nearLongitude)
              ? { latitude: input.nearLatitude, longitude: input.nearLongitude }
              : undefined

          const modes = yield* resolveDataMode
          const geocoder = getGeocoderForMode(modes.dataMode)

          const result = yield* geocoder
            .search({
              text: query,
              limit: Number.isFinite(input.limit) ? Math.min(Math.max(Math.trunc(input.limit!), 1), 10) : 5,
              near,
              signal: ctx.signal,
            })
            .pipe(
              Effect.mapError(
                (err) =>
                  new ToolExecutionError({
                    tool: 'disaster.geocode',
                    message: `${describeGeoError(err)} ${remedyForGeoError(err)}`,
                    cause: err,
                  }),
              ),
            )

          const searchGeojson: FeatureCollection = {
            type: 'FeatureCollection',
            features: result.matches.map((match) => ({
              type: 'Feature' as const,
              geometry: {
                type: 'Point' as const,
                coordinates: [match.at.longitude, match.at.latitude],
              },
              properties: {
                id: match.id,
                name: match.name,
                displayName: match.displayName,
                kind: match.kind,
                confidence: match.confidence,
                simulated: match.provenance.mode === 'fixture',
              },
            })),
          }

          const attributions = Array.from(
            new Set(result.matches.map((m) => m.provenance.attribution).filter(Boolean)),
          )
          yield* currentMapPort.setLayer('search-results', searchGeojson, { attributions })

          return textResult(
            summariseGeocode({
              dataMode: currentDataMode,
              result,
              layerUpdated: {
                layerId: 'search-results',
                featureCount: result.matches.length,
                vertexCount: result.matches.length,
              },
            }),
          )
        }),
    },

    // 3. disaster.flood_forecast
    {
      name: 'disaster.flood_forecast',
      title: 'Flood forecast & hazard map',
      description:
        'Retrieve flood inundation zones (forecast or scenario) within query radius.' + USES_CURRENT_LOCATION,
      inputSchema: Schema.Struct({
        latitude: Schema.optional(LATITUDE.annotations({ description: OPTIONAL_LATITUDE })),
        longitude: Schema.optional(LONGITUDE.annotations({ description: OPTIONAL_LONGITUDE })),
        radiusKm: Schema.optional(RADIUS_KM.annotations({ description: 'Search radius in km (1-20 km, default 20)' })),
        horizonHours: Schema.optional(HORIZON_HOURS.annotations({ description: 'Forecast horizon in hours (1-120, default 24)' })),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input, _ctx) =>
        Effect.gen(function* () {
          const loc = yield* resolveOrUseLocation('disaster.flood_forecast', input)
          const clamped = clampRadius(input.radiusKm)
          const modes = yield* resolveDataMode
          const registry = getRegistryForMode(modes.dataMode, modes.routingMode)
          const regionRes = yield* resolveRegion(loc.coordinates).pipe(
            Effect.mapError(
              (err) =>
                new ToolExecutionError({
                  tool: 'disaster.flood_forecast',
                  message: `Region unsupported for (${loc.coordinates.latitude}, ${loc.coordinates.longitude}).`,
                  cause: err,
                }),
            ),
          )

          const bundle = registry[regionRes.region]
          const snapshotRes = yield* buildHazardSnapshot({
            location: loc,
            radiusKm: clamped.radiusKm,
            bundle,
            horizonHours: input.horizonHours ?? 24,
          }).pipe(
            Effect.mapError(
              (err) =>
                new ToolExecutionError({
                  tool: 'disaster.flood_forecast',
                  message: `Failed to build hazard snapshot: ${err.message ?? err._tag}`,
                  cause: err,
                }),
            ),
          )

          // Update map layer flood-zones
          const features = snapshotRes.hazardSnapshot.zones.map((z) => ({
            type: 'Feature' as const,
            geometry: z.geometry,
            properties: {
              id: z.id,
              hazardClass: z.hazardClass,
              kind: z.kind.kind,
              depth: z.depth,
            },
          }))

          const floodGeojson: FeatureCollection = {
            type: 'FeatureCollection',
            features,
          }

          yield* currentMapPort.setLayer('flood-zones', floodGeojson)

          if (snapshotRes.facilities.length > 0) {
            const facilitiesPointsGeojson: FeatureCollection = {
              type: 'FeatureCollection',
              features: snapshotRes.facilities.map((fac) => ({
                type: 'Feature' as const,
                geometry: {
                  type: 'Point' as const,
                  coordinates: [fac.at.longitude, fac.at.latitude],
                },
                properties: {
                  id: fac.id,
                  name: fac.name,
                  category: fac.category,
                  risk: fac.risk,
                  distanceMetres: fac.metres,
                },
              })),
            }
            const facilityAttributions = Array.from(
              new Set(snapshotRes.facilities.map((f) => f.provenance.attribution).filter(Boolean)),
            )
            yield* currentMapPort.setLayer('facilities', facilitiesPointsGeojson, {
              attributions: facilityAttributions,
            })
          }

          let summary = summariseFlood({
            dataMode: currentDataMode,
            snapshot: snapshotRes.hazardSnapshot,
            regionRule: snapshotRes.regionRule,
            layerUpdated: {
              layerId: 'flood-zones',
              featureCount: features.length,
              vertexCount: snapshotRes.hazardSnapshot.geometryStats.verticesOut,
            },
          })

          if (clamped.wasClamped) {
            summary = `[Note: requested radius ${clamped.requestedKm} km clamped to ${clamped.radiusKm} km]\n${summary}`
          }

          return textResult(summary)
        }),
    },

    // 3a. disaster.inundation_model
    {
      name: 'disaster.inundation_model',
      title: 'Model inundation from terrain and rainfall',
      description:
        "Estimate which ground would flood, from this system's own terrain and rainfall model, and draw it on the map. " +
        'Use this only where no authority publishes a hazard map, or when the user explicitly asks what a given storm would do — ' +
        'disaster.flood_forecast is the one that returns official mapped and forecast hazard, and it is the one to prefer. ' +
        'The estimate over-predicts flooded area several-fold and is not an official product.' +
        USES_CURRENT_LOCATION,
      inputSchema: Schema.Struct({
        latitude: Schema.optional(LATITUDE.annotations({ description: OPTIONAL_LATITUDE })),
        longitude: Schema.optional(LONGITUDE.annotations({ description: OPTIONAL_LONGITUDE })),
        radiusKm: Schema.optional(
          RADIUS_KM.annotations({ description: 'Search radius in km (1-20 km, default 20)' }),
        ),
        rainfallMm: Schema.optional(
          RAINFALL_MM.annotations({
            description:
              'Design storm total in millimetres. Omit to let the model use the live rainfall forecast for this location.',
          }),
        ),
        durationHours: Schema.optional(
          DURATION_HOURS.annotations({ description: 'Hours the design storm falls over (1-168, default 48).' }),
        ),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input, ctx) =>
        Effect.gen(function* () {
          const loc = yield* resolveOrUseLocation('disaster.inundation_model', input)
          const clamped = clampRadius(input.radiusKm)

          const result = yield* fetchInundationModel({
            at: loc.coordinates,
            radiusKm: clamped.radiusKm,
            rainfallMm: input.rainfallMm,
            durationHours: input.durationHours,
            signal: ctx.signal,
          })

          yield* currentMapPort.setLayer(
            'inundation-model',
            inundationToFeatureCollection(result.zones),
            { attributions: result.attributions },
          )

          let summary = summariseInundationModel({
            result,
            radiusKm: clamped.radiusKm,
            dataMode: currentDataMode,
          })
          if (clamped.wasClamped) {
            summary = `[Note: requested radius ${clamped.requestedKm} km clamped to ${clamped.radiusKm} km]\n${summary}`
          }
          return textResult(summary)
        }),
    },

    // 4. disaster.find_shelters
    {
      name: 'disaster.find_shelters',
      title: 'Find safe facilities & shelters',
      description:
        'Find officially designated shelters and safe public facilities with flood risk evaluation.' +
        USES_CURRENT_LOCATION,
      inputSchema: Schema.Struct({
        latitude: Schema.optional(LATITUDE.annotations({ description: OPTIONAL_LATITUDE })),
        longitude: Schema.optional(LONGITUDE.annotations({ description: OPTIONAL_LONGITUDE })),
        radiusKm: Schema.optional(RADIUS_KM.annotations({ description: 'Search radius in km (1-20, default 20).' })),
        limit: Schema.optional(RESULT_LIMIT.annotations({ description: 'Maximum facilities to return (1-10, default 10).' })),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, _ctx) =>
        Effect.gen(function* () {
          const loc = yield* resolveOrUseLocation('disaster.find_shelters', input)
          const clamped = clampRadius(input.radiusKm)
          const modes = yield* resolveDataMode
          const registry = getRegistryForMode(modes.dataMode, modes.routingMode)
          const regionRes = yield* resolveRegion(loc.coordinates).pipe(
            Effect.mapError(
              (err) =>
                new ToolExecutionError({
                  tool: 'disaster.find_shelters',
                  message: `Region unsupported.`,
                  cause: err,
                }),
            ),
          )

          const bundle = registry[regionRes.region]
          const snapshotRes = yield* buildHazardSnapshot({
            location: loc,
            radiusKm: clamped.radiusKm,
            bundle,
          }).pipe(
            Effect.mapError(
              (err) =>
                new ToolExecutionError({
                  tool: 'disaster.find_shelters',
                  message: `Failed to query safe facilities: ${err.message ?? err._tag}`,
                  cause: err,
                }),
            ),
          )

          const facilities = snapshotRes.facilities.slice(0, input.limit ?? 10)

          const pointsGeojson: FeatureCollection = {
            type: 'FeatureCollection',
            features: facilities.map((fac) => ({
              type: 'Feature' as const,
              geometry: {
                type: 'Point' as const,
                coordinates: [fac.at.longitude, fac.at.latitude],
              },
              properties: {
                id: fac.id,
                name: fac.name,
                category: fac.category,
                risk: fac.risk,
                distanceMetres: fac.metres,
              },
            })),
          }

          const facilityAttributions = Array.from(
            new Set(facilities.map((f) => f.provenance.attribution).filter(Boolean)),
          )
          yield* currentMapPort.setLayer('facilities', pointsGeojson, {
            attributions: facilityAttributions,
          })

          let summary = summarisePlaces({
            dataMode: currentDataMode,
            facilities,
            location: loc,
            radiusKm: clamped.radiusKm,
            regionRule: snapshotRes.regionRule,
            layerUpdated: {
              layerId: 'facilities',
              featureCount: facilities.length,
              vertexCount: facilities.length,
            },
          })

          if (clamped.wasClamped) {
            summary = `[Note: requested radius ${clamped.requestedKm} km clamped to ${clamped.radiusKm} km]\n${summary}`
          }

          return textResult(summary)
        }),
    },

    // 5. disaster.evacuation_routes
    {
      name: 'disaster.evacuation_routes',
      title: 'Plan evacuation routes',
      description:
        'Plan routes from the user to safe destinations, with flood avoidance and crossing analysis. ' +
        'To route to one particular shelter, pass its name as `destination`; omit `destination` to route to the nearest safe facilities automatically. ' +
        'latitude and longitude are the starting point, never the destination.' +
        USES_CURRENT_LOCATION,
      inputSchema: Schema.Struct({
        destination: Schema.optional(
          Schema.String.annotations({
            description:
              'Name or id of the one facility to route to, as listed by disaster.find_shelters (for example "指定緊急避難場所 (北部地区センター)"). Omit to route to the nearest safe facilities automatically. Never put coordinates here.',
          }),
        ),
        latitude: Schema.optional(LATITUDE.annotations({ description: OPTIONAL_LATITUDE })),
        longitude: Schema.optional(LONGITUDE.annotations({ description: OPTIONAL_LONGITUDE })),
        radiusKm: Schema.optional(RADIUS_KM.annotations({ description: 'Search radius in km (1-20, default 20).' })),
        mode: Schema.optional(Schema.Literal('walk', 'bike', 'car')),
        limit: Schema.optional(RESULT_LIMIT.annotations({ description: 'Maximum route candidates (1-10, default 3).' })),
        avoidFlood: Schema.optional(Schema.Boolean),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, _ctx) =>
        Effect.gen(function* () {
          const loc = yield* resolveOrUseLocation('disaster.evacuation_routes', input)
          const clamped = clampRadius(input.radiusKm)
          const modes = yield* resolveDataMode
          const registry = getRegistryForMode(modes.dataMode, modes.routingMode)
          const regionRes = yield* resolveRegion(loc.coordinates).pipe(
            Effect.mapError(
              (err) =>
                new ToolExecutionError({
                  tool: 'disaster.evacuation_routes',
                  message: `Region unsupported.`,
                  cause: err,
                }),
            ),
          )

          const bundle = registry[regionRes.region]
          const snapshotRes = yield* buildHazardSnapshot({
            location: loc,
            radiusKm: clamped.radiusKm,
            bundle,
          }).pipe(
            Effect.mapError(
              (err) =>
                new ToolExecutionError({
                  tool: 'disaster.evacuation_routes',
                  message: `Failed to build hazard snapshot: ${err.message ?? err._tag}`,
                  cause: err,
                }),
            ),
          )

          const costing = input.mode === 'bike' ? 'bicycle' : input.mode === 'car' ? 'auto' : 'pedestrian'

          const named = input.destination?.trim() ?? ''
          const destinations =
            named === '' ? snapshotRes.facilities : findFacilitiesByName(snapshotRes.facilities, named)

          if (named !== '' && destinations.length === 0) {
            // Name the candidates rather than just refusing: the model can retry in one step, and
            // the user sees which shelters are actually in range.
            return yield* Effect.fail(
              new ToolExecutionError({
                tool: 'disaster.evacuation_routes',
                message:
                  snapshotRes.facilities.length === 0
                    ? `No safe facilities at all within ${clamped.radiusKm.toFixed(1)} km, so "${named}" cannot be routed to. Widen radiusKm or pick a different starting point.`
                    : `No facility matching "${named}" within ${clamped.radiusKm.toFixed(1)} km. In range: ${snapshotRes.facilities.map((f) => f.name).join('; ')}. Retry with one of those names.`,
              }),
            )
          }

          const planRes = yield* planEvacuationRoutes({
            origin: loc.coordinates,
            facilities: destinations,
            floodZones: snapshotRes.hazardSnapshot.zones,
            hasFloodCoverage: snapshotRes.hazardSnapshot.coverage.state !== 'none',
            routingPort: bundle.routing,
            costing,
            // A named destination is the whole request; ranking and trimming it away would answer
            // a different question.
            limit: named === '' ? input.limit ?? 3 : destinations.length,
            avoidFlood: input.avoidFlood ?? true,
          })

          const routeLines: FeatureCollection = {
            type: 'FeatureCollection',
            features: planRes.routes.map((r, i) => ({
              type: 'Feature' as const,
              geometry: r.geometry,
              properties: {
                rank: i + 1,
                destination: r.destination.name,
                destinationRisk: r.destination.risk,
                metres: r.metres,
                seconds: r.seconds,
                costing: r.costing,
                exclusions: r.exclusions,
                crossings: r.crossings.count,
                crossingsAssessed: r.crossings.assessed,
                exposedMetres: r.crossings.exposedMetres,
                // Every published route follows the road network — the planner keeps straight
                // lines out — but the layer says so explicitly so a reader of the GeoJSON, or a
                // future writer to this layer, cannot mistake the guarantee for an accident.
                network: r.network,
                simulated: r.provenance.mode === 'fixture',
                // Carried on the feature so the directions panel reads the same route the map
                // draws; the map port is the only channel between a tool and the UI.
                steps: r.steps,
              },
            })),
          }

          const routeAttributions = Array.from(
            new Set(planRes.routes.map((r) => r.provenance.attribution).filter(Boolean)),
          )
          yield* currentMapPort.setLayer('routes', routeLines, { attributions: routeAttributions })

          if (snapshotRes.facilities.length > 0) {
            const facilitiesPointsGeojson: FeatureCollection = {
              type: 'FeatureCollection',
              features: snapshotRes.facilities.map((fac) => ({
                type: 'Feature' as const,
                geometry: {
                  type: 'Point' as const,
                  coordinates: [fac.at.longitude, fac.at.latitude],
                },
                properties: {
                  id: fac.id,
                  name: fac.name,
                  category: fac.category,
                  risk: fac.risk,
                  distanceMetres: fac.metres,
                },
              })),
            }
            const facilityAttributions = Array.from(
              new Set(snapshotRes.facilities.map((f) => f.provenance.attribution).filter(Boolean)),
            )
            yield* currentMapPort.setLayer('facilities', facilitiesPointsGeojson, {
              attributions: facilityAttributions,
            })
          }

          let summary = summariseRoutes({
            dataMode: currentDataMode,
            plan: planRes,
            location: loc,
            radiusKm: clamped.radiusKm,
            regionRule: snapshotRes.regionRule,
            layerUpdated: {
              layerId: 'routes',
              featureCount: planRes.routes.length,
              vertexCount: planRes.routes.reduce((sum, r) => sum + r.geometry.coordinates.length, 0),
            },
          })

          if (clamped.wasClamped) {
            summary = `[Note: requested radius ${clamped.requestedKm} km clamped to ${clamped.radiusKm} km]\n${summary}`
          }

          return textResult(summary)
        }),
    },

    // 6. disaster.official_alerts
    {
      name: 'disaster.official_alerts',
      title: 'Get official alerts and advisories',
      description:
        'Retrieve active disaster warnings and advisories in force from the authoritative agency. ' +
        'When the user names a place or area, pass it as placeName and call this tool immediately; ' +
        'do not ask for latitude or longitude and do not call disaster.geocode first. ' +
        "If the user names no place, omit placeName, latitude and longitude to use the device's current location — never guess coordinates.",
      inputSchema: Schema.Struct({
        placeName: Schema.optional(
          Schema.String.annotations({
            description:
              'The named place or warning area to check, for example "Tsugaru area", "青森県津軽地方", or "Berlin". Use this whenever the user supplies a place name; omit latitude and longitude.',
          }),
        ),
        latitude: Schema.optional(LATITUDE.annotations({ description: ALERT_OPTIONAL_LATITUDE })),
        longitude: Schema.optional(LONGITUDE.annotations({ description: ALERT_OPTIONAL_LONGITUDE })),
        radiusKm: Schema.optional(RADIUS_KM.annotations({ description: 'Search radius in km (1-20, default 20).' })),
        limit: Schema.optional(RESULT_LIMIT.annotations({ description: 'Maximum active alerts to return (1-10, default 10).' })),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, ctx) =>
        Effect.gen(function* () {
          const resolved = yield* resolveAlertLocation(input, ctx.signal)
          const loc = resolved.location
          const clamped = clampRadius(input.radiusKm)
          const modes = yield* resolveDataMode
          const registry = getRegistryForMode(modes.dataMode, modes.routingMode)
          const regionRes = yield* resolveRegion(loc.coordinates).pipe(
            Effect.mapError(
              (err) =>
                new ToolExecutionError({
                  tool: 'disaster.official_alerts',
                  message: `Region unsupported.`,
                  cause: err,
                }),
            ),
          )

          const bundle = registry[regionRes.region]
          const snapshotRes = yield* buildHazardSnapshot({
            location: loc,
            radiusKm: clamped.radiusKm,
            bundle,
          }).pipe(
            Effect.mapError(
              (err) =>
                new ToolExecutionError({
                  tool: 'disaster.official_alerts',
                  message: `Failed to query alerts: ${err.message ?? err._tag}`,
                  cause: err,
                }),
            ),
          )

          const summary = summariseAlerts({
            dataMode: currentDataMode,
            alerts: snapshotRes.alerts.slice(0, input.limit ?? 10),
            location: loc,
            regionRule: snapshotRes.regionRule,
            coverage: snapshotRes.alertsCoverage,
            totalCount: snapshotRes.totalAlertCount,
            expiredCount: snapshotRes.expiredAlertCount,
          })

          const placeResolution = resolved.matchedPlace
            ? `Named alert area resolved: ${resolved.matchedPlace.displayName} (${resolved.matchedPlace.kind})\n`
            : ''
          return textResult(placeResolution + summary)
        }),
    },

    // 7. disaster.focus_map
    {
      name: 'disaster.focus_map',
      title: 'Focus map on layer',
      description:
        'Re-frame the map camera to focus on specific layer features (user, floods, facilities, routes, search, all).',
      inputSchema: Schema.Struct({
        target: Schema.Literal('user', 'floods', 'facilities', 'routes', 'search', 'all').annotations({
          description: 'The layer or feature target to frame',
        }),
      }),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input, _ctx) =>
        Effect.gen(function* () {
          yield* currentMapPort.focus(input.target)
          return textResult(`Map camera focused on "${input.target}".`)
        }),
    },

    // 8. disaster.clear_map
    {
      name: 'disaster.clear_map',
      title: 'Clear map layers',
      description: 'Clear all active disaster safety layers from the map surface.',
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (_input, _ctx) =>
        Effect.gen(function* () {
          yield* currentMapPort.clear()
          return textResult('Cleared all disaster data layers from map.')
        }),
    },
  ],
}
