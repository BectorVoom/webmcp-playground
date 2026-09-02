import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { LonLat } from '../../src/domain/geo'
import type { FloodZone } from '../../src/domain/hazard'
import type { Provenance } from '../../src/domain/provenance'
import { clipAndMergeZones } from '../../src/lib/geometry/clip'
import { rasterTilesToFloodZones } from '../../src/lib/geometry/contour'
import {
  INUNDATION_BANDS,
  depthsToClassifiedTiles,
  summariseDepthsInCircle,
  type DepthSummary,
} from '../../src/lib/hydrology/bands'
import {
  DEFAULT_CURVE_NUMBER,
  MAX_CURVE_NUMBER,
  MIN_CURVE_NUMBER,
  estimateRunoff,
} from '../../src/lib/hydrology/runoff'
import { spreadRunoff, type SpreadResult } from '../../src/lib/hydrology/spread'
import { mosaicGeometry, type ElevationMosaic } from '../../src/lib/hydrology/terrain'
import type { ServerConfig } from '../config'
import type { AppEnv } from '../env'
import {
  DEFAULT_DURATION_HOURS,
  DEFAULT_RADIUS_KM,
  DEM_ATTRIBUTION,
  MAX_DESIGN_STORM_MM,
  MAX_DURATION_HOURS,
  MAX_RADIUS_KM,
  PrecipitationUnavailable,
  badRequest,
  chooseDemZoom,
  demTileUrl,
  loadTerrain,
  numberInRange,
  resolvePrecipitation,
} from '../flood-inputs'
import { GeoProxyService } from '../geo-proxy'
import { upstreamErrorStatus } from './geo'

/**
 * POST /api/geo/inundation-estimate
 *
 * Estimates pluvial (rainfall-driven) inundation depth and extent around a
 * point, from first principles rather than a published hazard map:
 *
 *   1. Terrain: Terrarium-encoded DEM tiles (Mapzen/AWS Terrain Tiles).
 *   2. Precipitation: accumulated forecast rainfall from Open-Meteo, or a
 *      caller-supplied design storm.
 *   3. Runoff: SCS Curve Number method (USDA-NRCS TR-55).
 *   4. Spreading: Priority-Flood depression analysis with level-pool
 *      fill-and-spill routing.
 *   5. Extent: banded on the GSI depth legend and vectorised through the same
 *      pipeline the hazard-map providers use, then clipped to the query circle.
 *
 * This models ponding of rain where it falls. For river routing, channel
 * inflow from upstream catchments, and levee breaches, see
 * `POST /api/geo/flood-model`.
 */

interface InundationRequestBody {
  readonly at?: { readonly latitude?: number; readonly longitude?: number }
  readonly radiusKm?: number
  /** Design-storm override. When absent, forecast rainfall is fetched. */
  readonly rainfallMm?: number
  /** Accumulation window for forecast rainfall, hours from now. */
  readonly durationHours?: number
  readonly curveNumber?: number
}

const LIMITATIONS: ReadonlyArray<string> = [
  'Screening model for rainfall-driven (pluvial) ponding only: river routing, storm surge, dam operation and levee failure are not modelled. For those, use POST /api/geo/flood-model.',
  'Runoff uses one curve number for the whole area; local soil and land cover will make real runoff higher or lower.',
  'Urban drainage (sewers, pumps, culverts) is not modelled, so shallow urban ponding is overestimated where drainage works and flood timing is not predicted at all.',
  'The DEM is a surface model at ~30-90 m resolution; narrow channels, underpasses and building interiors are below its resolution.',
  'Rainfall is applied uniformly from point samples; convective cells smaller than the query circle are smoothed out.',
  'Open water (cells at or below sea level connected to the domain edge) is treated as an outlet; coastal flooding from the sea side is out of scope.',
  'This estimate never overrides official hazard maps or active warnings — where they disagree, trust the authorities.',
]

interface EstimateComputation {
  readonly spread: SpreadResult
  readonly summary: DepthSummary
  readonly zones: ReadonlyArray<FloodZone>
  readonly meanCellMetres: number
}

const computeEstimate = (
  mosaic: ElevationMosaic,
  at: LonLat,
  radiusKm: number,
  runoffMm: number,
  provenance: Provenance,
  designEvent: string,
): EstimateComputation => {
  const geometry = mosaicGeometry(mosaic)
  const spread = spreadRunoff({
    elevations: mosaic.elevations,
    width: mosaic.width,
    height: mosaic.height,
    runoffMetres: runoffMm / 1000,
    rowCellAreaM2: geometry.rowCellAreaM2,
    // Terrarium tiles carry bathymetry; without this the sea floor would be
    // reported as the deepest flood on any coastal map.
    oceanLevelMetres: 0,
  })

  const summary = summariseDepthsInCircle(mosaic, geometry, spread.depths, at, radiusKm)

  const midRow = Math.floor(mosaic.height / 2)
  const meanCellMetres = Math.round(
    (geometry.rowCellWidthM[midRow]! + geometry.rowCellHeightM[midRow]!) / 2,
  )

  // Vectorised at the model's own cell size. Coarsening it is the obvious
  // saving and was rejected: `coarsen` keeps the worst class in each block, so
  // the extent rounds outward and the polygons stop agreeing with the reported
  // area — 1.55x too much ground at twice the cell size.
  const classified = depthsToClassifiedTiles(mosaic, spread.depths)
  const rawZones = rasterTilesToFloodZones([...classified], provenance, designEvent)
  const { zones } = clipAndMergeZones(rawZones, at, radiusKm)

  return { spread, summary, zones, meanCellMetres }
}

export const inundationRoutes = (config: ServerConfig, proxyService?: GeoProxyService) => {
  const router = new Hono<AppEnv>()
  const proxy = proxyService ?? new GeoProxyService(config)

  router.post('/inundation-estimate', async (c) => {
    let body: InundationRequestBody
    try {
      body = (await c.req.json()) as InundationRequestBody
    } catch {
      return c.json({ error: 'ValidationError', message: 'Malformed JSON body' }, 400)
    }

    const latitude = body?.at?.latitude
    const longitude = body?.at?.longitude
    if (!numberInRange(latitude, -85, 85)) {
      return c.json(badRequest('at.latitude', 'Must be a latitude between -85 and 85'), 400)
    }
    if (!numberInRange(longitude, -180, 180)) {
      return c.json(badRequest('at.longitude', 'Must be a longitude between -180 and 180'), 400)
    }
    const at: LonLat = { latitude, longitude }

    const radiusKm = body.radiusKm ?? DEFAULT_RADIUS_KM
    if (!numberInRange(radiusKm, 1, MAX_RADIUS_KM)) {
      return c.json(badRequest('radiusKm', `Must be between 1 and ${MAX_RADIUS_KM} km`), 400)
    }
    const durationHours = body.durationHours ?? DEFAULT_DURATION_HOURS
    if (!numberInRange(durationHours, 1, MAX_DURATION_HOURS) || !Number.isInteger(durationHours)) {
      return c.json(badRequest('durationHours', `Must be an integer between 1 and ${MAX_DURATION_HOURS}`), 400)
    }
    const curveNumber = body.curveNumber ?? DEFAULT_CURVE_NUMBER
    if (!numberInRange(curveNumber, MIN_CURVE_NUMBER, MAX_CURVE_NUMBER)) {
      return c.json(
        badRequest('curveNumber', `Must be between ${MIN_CURVE_NUMBER} and ${MAX_CURVE_NUMBER}`),
        400,
      )
    }
    if (body.rainfallMm !== undefined && !numberInRange(body.rainfallMm, 0, MAX_DESIGN_STORM_MM)) {
      return c.json(badRequest('rainfallMm', `Must be between 0 and ${MAX_DESIGN_STORM_MM} mm`), 400)
    }

    const fixtureMode = config.geoDataMode === 'fixture'
    const { zoom, range } = chooseDemZoom(at, radiusKm, config)

    const cacheKey = `inundation:${latitude.toFixed(config.geoCoordPrecision)},${longitude.toFixed(config.geoCoordPrecision)}:${radiusKm}:${zoom}:${body.rainfallMm ?? 'forecast'}:${durationHours}:${curveNumber}:${config.geoDataMode}`
    const cached = proxy.getCache(cacheKey, config.geoCacheTtlFloodMs)
    if (cached) {
      c.header('x-cache-hit', 'true')
      c.header('x-cache-age-ms', String(cached.ageMs))
      return c.text(cached.entry.rawText, cached.entry.status as ContentfulStatusCode, {
        'content-type': cached.entry.contentType,
      })
    }

    try {
      const precipitation = await resolvePrecipitation(
        proxy, at, radiusKm, durationHours, body.rainfallMm, fixtureMode,
      )
      const { mosaic, cellsDespiked } = await loadTerrain(proxy, range, at, fixtureMode)

      const runoff = estimateRunoff(precipitation.rainfallMm, curveNumber)
      const retrievedAt = Date.now()
      const designEvent = `${precipitation.rainfallMm} mm / ${durationHours} h rainfall, CN ${curveNumber}`
      const provenance: Provenance = {
        sourceId: 'estimate.pluvial.scs-cn',
        sourceName: 'Model estimate: SCS-CN runoff over Terrarium DEM',
        upstreamUrl: fixtureMode ? 'fixture:synthetic-dem' : demTileUrl(zoom, range.minX, range.minY),
        datasetVintage: fixtureMode ? 'synthetic' : 'Mapzen/AWS Terrain Tiles (static compilation)',
        retrievedAt,
        cache: { hit: false, ageMs: 0 },
        licence: fixtureMode ? 'n/a (synthetic)' : 'ODbL / public domain (see attribution)',
        attribution: fixtureMode ? 'Synthetic fixture terrain' : DEM_ATTRIBUTION,
        mode: fixtureMode ? 'fixture' : 'live',
      }

      const estimate = computeEstimate(mosaic, at, radiusKm, runoff.runoffMm, provenance, designEvent)

      const response = {
        ok: true,
        mode: config.geoDataMode,
        location: { latitude, longitude },
        radiusKm,
        method: {
          name: 'SCS-CN runoff with priority-flood fill-and-spill spreading',
          runoff: 'USDA-NRCS Curve Number method (Technical Release 55, 1986)',
          spreading:
            'Priority-Flood depression analysis (Barnes, Lehman & Mulla 2014) with level-pool fill-and-spill volume routing (cf. Lhomme et al. 2008; Barnes, Callaghan & Wickert 2020)',
          dem: fixtureMode ? 'synthetic fixture terrain' : 'Mapzen/AWS Terrain Tiles, Terrarium encoding',
          demZoom: zoom,
          demCellMetres: estimate.meanCellMetres,
          demCellsDespiked: cellsDespiked,
          gridCells: mosaic.width * mosaic.height,
          depthBands: INUNDATION_BANDS,
        },
        precipitation: precipitation.detail,
        runoff: {
          curveNumber,
          rainfallMm: runoff.rainfallMm,
          runoffMm: Math.round(runoff.runoffMm * 100) / 100,
          initialAbstractionMm: Math.round(runoff.initialAbstractionMm * 100) / 100,
          potentialRetentionMm: Math.round(runoff.potentialRetentionMm * 100) / 100,
        },
        inundation: {
          maxDepthMetres: estimate.summary.maxDepthMetres,
          meanDepthMetres: estimate.summary.meanDepthMetres,
          floodedAreaKm2: estimate.summary.floodedAreaKm2,
          volume: {
            generatedM3: Math.round(estimate.spread.totalRunoffM3),
            pondedM3: Math.round(estimate.spread.storedM3),
            drainedM3: Math.round(estimate.spread.outflowM3),
          },
          depressionCount: estimate.spread.depressionCount,
          overflowingCount: estimate.spread.overflowingCount,
          oceanCellsMasked: estimate.spread.oceanCellCount,
          zones: estimate.zones,
        },
        provenance,
        limitations: LIMITATIONS,
      }

      const rawText = JSON.stringify(response)
      proxy.setCache(cacheKey, response, rawText, 200, 'application/json')
      c.header('x-cache-hit', 'false')
      c.header('x-cache-age-ms', '0')
      return c.text(rawText, 200, { 'content-type': 'application/json' })
    } catch (err: unknown) {
      if (err instanceof PrecipitationUnavailable) {
        return c.json({ error: 'UpstreamFailed', message: err.message }, 502)
      }
      const msg = err instanceof Error ? err.message : String(err)
      const { error, status } = upstreamErrorStatus(msg)
      return c.json({ error, message: msg }, status)
    }
  })

  return router
}
