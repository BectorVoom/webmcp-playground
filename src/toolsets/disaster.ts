import { Effect, Schema } from 'effect'
import { textResult, type ToolSet } from '../domain/tool'
import { ToolExecutionError } from '../domain/errors'
import { clampRadius, roundCoordsForOutbound, type LonLat, type ResolvedLocation } from '../domain/geo'
import { resolveRegion } from '../adapters/geo/region'
import { getRegistryForMode } from '../adapters/geo/registry'
import { BrowserGeolocationAdapter } from '../adapters/geo/browser-geolocation'
import { defaultMapPort } from '../adapters/map/memory-map'
import type { GeolocationPort } from '../ports/Geolocation'
import type { MapPort } from '../ports/Map'
import { buildHazardSnapshot } from '../app/hazard/snapshot'
import { planEvacuationRoutes } from '../app/hazard/routing-service'
import { createCirclePolygon } from '../lib/geometry/circle'
import {
  summariseAlerts,
  summariseFlood,
  summarisePlaces,
  summariseRoutes,
} from '../app/hazard/summarise'
import type { FeatureCollection } from 'geojson'

export let currentGeolocationPort: GeolocationPort = new BrowserGeolocationAdapter()
export let currentMapPort: MapPort = defaultMapPort
export let currentDataMode: 'live' | 'fixture' = 'fixture'

export const setDisasterDataMode = (mode: 'live' | 'fixture'): void => {
  currentDataMode = mode
}

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
              tool: 'disaster.locate',
              message: `Geolocation failed: ${err.message ?? err._tag}. Supply latitude and longitude explicitly.`,
              cause: err,
            }),
        ),
      )
    }

    yield* emitUserPositionLayer(loc)
    return loc
  })

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
      description: 'Resolve and pin current geolocation, returning coordinates, accuracy, source, and region.',
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (_input, _ctx) =>
        Effect.gen(function* () {
          const loc = yield* resolveOrUseLocation()
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

    // 2. disaster.flood_forecast
    {
      name: 'disaster.flood_forecast',
      title: 'Flood forecast & hazard map',
      description: 'Retrieve flood inundation zones (forecast or scenario) within query radius.',
      inputSchema: Schema.Struct({
        latitude: Schema.optional(Schema.Number.annotations({ description: 'Optional latitude in WGS84' })),
        longitude: Schema.optional(Schema.Number.annotations({ description: 'Optional longitude in WGS84' })),
        radiusKm: Schema.optional(Schema.Number.annotations({ description: 'Search radius in km (1-20 km, default 20)' })),
        horizonHours: Schema.optional(Schema.Number.annotations({ description: 'Forecast horizon in hours (default 24)' })),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input, _ctx) =>
        Effect.gen(function* () {
          const loc = yield* resolveOrUseLocation(input)
          const clamped = clampRadius(input.radiusKm)
          const registry = getRegistryForMode(currentDataMode)
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
            yield* currentMapPort.setLayer('facilities', facilitiesPointsGeojson)
          }

          let summary = summariseFlood({
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

    // 3. disaster.find_shelters
    {
      name: 'disaster.find_shelters',
      title: 'Find safe facilities & shelters',
      description: 'Find officially designated shelters and safe public facilities with flood risk evaluation.',
      inputSchema: Schema.Struct({
        latitude: Schema.optional(Schema.Number),
        longitude: Schema.optional(Schema.Number),
        radiusKm: Schema.optional(Schema.Number),
        limit: Schema.optional(Schema.Number),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, _ctx) =>
        Effect.gen(function* () {
          const loc = yield* resolveOrUseLocation(input)
          const clamped = clampRadius(input.radiusKm)
          const registry = getRegistryForMode(currentDataMode)
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

          yield* currentMapPort.setLayer('facilities', pointsGeojson)

          let summary = summarisePlaces({
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

    // 4. disaster.evacuation_routes
    {
      name: 'disaster.evacuation_routes',
      title: 'Plan evacuation routes',
      description: 'Plan routes to safe destinations with flood avoidance and crossing analysis.',
      inputSchema: Schema.Struct({
        latitude: Schema.optional(Schema.Number),
        longitude: Schema.optional(Schema.Number),
        radiusKm: Schema.optional(Schema.Number),
        mode: Schema.optional(Schema.Literal('walk', 'bike', 'car')),
        limit: Schema.optional(Schema.Number),
        avoidFlood: Schema.optional(Schema.Boolean),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, _ctx) =>
        Effect.gen(function* () {
          const loc = yield* resolveOrUseLocation(input)
          const clamped = clampRadius(input.radiusKm)
          const registry = getRegistryForMode(currentDataMode)
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

          const planRes = yield* planEvacuationRoutes({
            origin: loc.coordinates,
            facilities: snapshotRes.facilities,
            floodZones: snapshotRes.hazardSnapshot.zones,
            hasFloodCoverage: snapshotRes.hazardSnapshot.coverage.state !== 'none',
            routingPort: bundle.routing,
            costing,
            limit: input.limit ?? 3,
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
                metres: r.metres,
                seconds: r.seconds,
                exclusions: r.exclusions,
                crossings: r.crossings.count,
              },
            })),
          }

          yield* currentMapPort.setLayer('routes', routeLines)

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
            yield* currentMapPort.setLayer('facilities', facilitiesPointsGeojson)
          }

          let summary = summariseRoutes({
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

    // 5. disaster.official_alerts
    {
      name: 'disaster.official_alerts',
      title: 'Get official alerts and advisories',
      description: 'Retrieve active disaster warnings and advisories in force from the authoritative agency.',
      inputSchema: Schema.Struct({
        latitude: Schema.optional(Schema.Number),
        longitude: Schema.optional(Schema.Number),
        radiusKm: Schema.optional(Schema.Number),
        limit: Schema.optional(Schema.Number),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, _ctx) =>
        Effect.gen(function* () {
          const loc = yield* resolveOrUseLocation(input)
          const clamped = clampRadius(input.radiusKm)
          const registry = getRegistryForMode(currentDataMode)
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
            alerts: snapshotRes.alerts.slice(0, input.limit ?? 10),
            location: loc,
            regionRule: snapshotRes.regionRule,
            totalCount: snapshotRes.totalAlertCount,
            expiredCount: snapshotRes.expiredAlertCount,
          })

          return textResult(summary)
        }),
    },

    // 6. disaster.focus_map
    {
      name: 'disaster.focus_map',
      title: 'Focus map on layer',
      description: 'Re-frame the map camera to focus on specific layer features (user, floods, facilities, routes, all).',
      inputSchema: Schema.Struct({
        target: Schema.Literal('user', 'floods', 'facilities', 'routes', 'all').annotations({
          description: 'The layer or feature target to frame',
        }),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input, _ctx) =>
        Effect.gen(function* () {
          yield* currentMapPort.focus(input.target)
          return textResult(`Map camera focused on "${input.target}".`)
        }),
    },

    // 7. disaster.clear_map
    {
      name: 'disaster.clear_map',
      title: 'Clear map layers',
      description: 'Clear all active disaster safety layers from the map surface.',
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (_input, _ctx) =>
        Effect.gen(function* () {
          yield* currentMapPort.clear()
          return textResult('Cleared all disaster data layers from map.')
        }),
    },
  ],
}
