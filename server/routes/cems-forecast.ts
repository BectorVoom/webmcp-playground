/**
 * POST /api/geo/cems-forecast — the European flood forecast (R2.1, R7.1, R7.2).
 *
 * This is a server route rather than a proxied upstream because neither half of the work can
 * happen in a browser: the retrieval is authenticated with a token that must never reach the
 * bundle, and it is a queued job whose answer arrives minutes later in a binary format. So the
 * server does the retrieving, the decoding and the scoring, and hands the client the same
 * `FloodQueryResult` every other flood provider produces.
 *
 * A request that is not ready is answered 202 with a coverage statement saying so, never with an
 * empty zone list: "we have not fetched this yet" and "nothing here will flood" are the two
 * answers this feature exists to keep apart.
 */
import { Hono } from 'hono'
import type { ServerConfig } from '../config'
import type { AppEnv } from '../env'
import type { GeoProxyService } from '../geo-proxy'
import { resolveCemsCredentials, type CemsCredentials } from '../cems/credentials'
import { gridBBox } from '../cems/glofas-grid'
import { FORECAST_LEAD_HOURS } from '../cems/glofas-request'
import { GlofasForecastService, type ForecastOutcome } from '../cems/glofas-service'
import type { BBox } from '../../src/domain/geo'
import type { FloodZone } from '../../src/domain/hazard'
import type { Coverage, Provenance } from '../../src/domain/provenance'
import { vectoriseTileGrid } from '../../src/lib/geometry/contour'

export const CEMS_FORECAST_SOURCE_ID = 'eu.copernicus.glofas-forecast'

const SOURCE_NAME = 'Copernicus GloFAS — ensemble river discharge forecast'
const DOCS_URL = 'https://ewds.climate.copernicus.eu/datasets/cems-glofas-forecast'
const LICENCE = 'Copernicus Open Access (free reuse with attribution)'
const ATTRIBUTION =
  'Copernicus Emergency Management Service — Global Flood Awareness System (GloFAS), via the ECMWF Data Store'

/** A new run lands daily; past that the forecast on the map is yesterday's weather. */
const EXPECTED_REFRESH_MS = 86_400_000

interface ForecastRequestBody {
  readonly at?: { readonly latitude?: number; readonly longitude?: number }
  readonly radiusKm?: number
}

const horizonHours = FORECAST_LEAD_HOURS[FORECAST_LEAD_HOURS.length - 1]!

/**
 * The zones, vectorised from the classified cells.
 *
 * No `cellMetres` is passed: the default coarsening cell is 40 m and a GloFAS cell is some
 * kilometres across, so the vectoriser leaves the grid at its own resolution — which is what
 * should happen. Coarsening a 5 km cell would be inventing detail, not removing it.
 */
const buildZones = (outcome: ForecastOutcome, provenance: Provenance): ReadonlyArray<FloodZone> => {
  const { grid, classified, run } = outcome
  if (grid === undefined || classified === undefined || run === undefined) return []

  const fallback: BBox = outcome.area
    ? [outcome.area[1], outcome.area[2], outcome.area[3], outcome.area[0]]
    : [0, 0, 0, 0]
  const bbox = gridBBox(grid, fallback)
  const depths = new Array(classified.grid.length).fill(undefined)

  return vectoriseTileGrid(classified.grid, depths, grid.width, grid.height, bbox).map((zone) => ({
    id: `glofas-forecast-${zone.hazardClass}`,
    kind: {
      kind: 'forecast' as const,
      validFrom: run.basetime,
      validTo: run.basetime + horizonHours * 3_600_000,
    },
    hazardClass: zone.hazardClass,
    depth: undefined,
    geometry: zone.geometry,
    provenance,
  }))
}

/**
 * What the map is and is not showing.
 *
 * Three things have to be said even when the retrieval worked. The forecast is river discharge, so
 * it says nothing about rain falling on a hillside or a drain backing up. Cells with no fittable
 * flood-frequency record carry no verdict at all rather than a favourable one. And a 0.05° model
 * does not resolve the small watercourse a national map would.
 */
const describeCoverage = (outcome: ForecastOutcome, zoneCount: number, radiusKm: number): Coverage => {
  const { classified, fittedCells } = outcome
  const unfitted = classified?.unfittedCells ?? 0
  const totalCells = (fittedCells ?? 0) + unfitted

  const caveats = [
    'GloFAS models river discharge on a 0.05° grid, so it does not resolve small watercourses, ' +
      'surface-water flooding from rainfall, or drainage failure.',
  ]
  if (unfitted > 0) {
    caveats.push(
      `${unfitted} of ${totalCells} cells have no 1991–2020 record that supports a flood ` +
        `frequency fit — mostly cells that carry no river — and carry no verdict either way.`,
    )
  }

  if (zoneCount === 0) {
    return {
      state: unfitted > 0 ? 'partial' : 'full',
      reason: unfitted > 0 ? 'no_data_for_area' : undefined,
      detail:
        `No cell within ${radiusKm} km is forecast to exceed its two-year flood in the next ` +
        `${horizonHours / 24} days with at least a 30% ensemble probability. ${caveats.join(' ')}`,
      failedSources: [],
    }
  }

  return {
    state: unfitted > 0 ? 'partial' : 'full',
    reason: unfitted > 0 ? 'no_data_for_area' : undefined,
    detail: caveats.join(' '),
    failedSources: [],
  }
}

/**
 * Credentials are passed in rather than read from the environment here, so that a caller — the
 * server at startup, or a test — decides what this route is configured with. Reading `process.env`
 * inside the route made "no token configured" untestable on any machine that had one.
 */
export interface CemsForecastOptions {
  readonly credentials?: CemsCredentials
}

export const cemsForecastRoutes = (
  config: ServerConfig,
  proxy: GeoProxyService,
  options: CemsForecastOptions = { credentials: resolveCemsCredentials() },
) => {
  const router = new Hono<AppEnv>()
  const service = new GlofasForecastService(proxy, options.credentials, {
    cacheDir: config.cemsCacheDir,
  })

  router.post('/cems-forecast', async (c) => {
    let body: ForecastRequestBody
    try {
      body = (await c.req.json()) as ForecastRequestBody
    } catch {
      return c.json({ error: 'ValidationError', message: 'Malformed JSON body' }, 400)
    }

    const latitude = body?.at?.latitude
    const longitude = body?.at?.longitude
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'at.latitude', message: 'Must be a valid latitude between -90 and 90' }],
        },
        400,
      )
    }
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'at.longitude', message: 'Must be a valid longitude between -180 and 180' }],
        },
        400,
      )
    }

    const radiusKm = typeof body.radiusKm === 'number' && body.radiusKm > 0 ? body.radiusKm : 20

    // Fixture mode never calls out, exactly as every other geo route behaves.
    if (config.geoDataMode === 'fixture') {
      return c.json({
        ok: true,
        mode: 'fixture',
        sourceId: CEMS_FORECAST_SOURCE_ID,
        state: 'unconfigured',
        detail:
          'GEO_DATA_MODE=fixture, so the Copernicus forecast was not retrieved. There is no ' +
          'recorded GloFAS ensemble to replay in its place.',
        zones: [],
      })
    }

    const outcome = await service.advance({ latitude, longitude }, radiusKm)

    if (outcome.state !== 'ready') {
      // 202 for work in progress, 200 for a settled "we cannot do this" — the client falls back
      // either way, but only one of them is worth asking about again.
      return c.json(
        {
          ok: true,
          sourceId: CEMS_FORECAST_SOURCE_ID,
          state: outcome.state,
          detail: outcome.detail,
          progress: outcome.progress,
          zones: [],
        },
        outcome.state === 'pending' ? 202 : 200,
      )
    }

    const provenance: Provenance = {
      sourceId: CEMS_FORECAST_SOURCE_ID,
      sourceName: SOURCE_NAME,
      upstreamUrl: DOCS_URL,
      datasetVintage: `GloFAS run ${new Date(outcome.run!.basetime).toISOString().slice(0, 10)} 00Z`,
      issuedAt: outcome.run!.basetime,
      retrievedAt: Date.now(),
      cache: { hit: false, ageMs: 0 },
      licence: LICENCE,
      attribution: ATTRIBUTION,
      mode: 'live',
    }

    const zones = buildZones(outcome, provenance)
    const ageMs = Date.now() - outcome.run!.basetime

    return c.json({
      ok: true,
      sourceId: CEMS_FORECAST_SOURCE_ID,
      state: 'ready',
      detail: outcome.detail,
      progress: outcome.progress,
      run: {
        basetime: outcome.run!.basetime,
        leadHours: FORECAST_LEAD_HOURS,
        memberCount: outcome.classified!.memberCount,
      },
      zones,
      coverage: describeCoverage(outcome, zones.length, radiusKm),
      staleness: { stale: ageMs > EXPECTED_REFRESH_MS, ageMs, expectedRefreshMs: EXPECTED_REFRESH_MS },
    })
  })

  return router
}
