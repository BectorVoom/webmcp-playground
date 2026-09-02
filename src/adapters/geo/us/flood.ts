import { Effect } from 'effect'
import type { HazardClass, DepthBand, FloodZone, ZoneKind } from '../../../domain/hazard'
import type { LonLat } from '../../../domain/geo'
import type { Coverage, Provenance } from '../../../domain/provenance'
import type {
  FloodDataPort,
  FloodQuery,
  FloodQueryResult,
  ProviderMeta,
} from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { createCircleBBox } from '../../../lib/geometry/circle'
import { FixtureFloodProvider } from '../fixture/fixture-flood'
import { fetchViaProxy, parseUpstreamJson } from '../proxy-client'

interface NfhlProperties {
  readonly FLD_ZONE?: string
  readonly ZONE_SUBTY?: string | null
  readonly DEPTH?: number | null
  readonly STATIC_BFE?: number | null
}
export interface NfhlPayload {
  readonly features?: ReadonlyArray<{
    readonly id?: string | number
    readonly properties?: NfhlProperties
    readonly geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon | null
  }>
  readonly error?: { readonly message?: string }
}

/**
 * FEMA's flood zone letters, mapped onto our hazard classes.
 *
 * The letters are a regulatory vocabulary, not a severity scale, so the mapping is deliberate:
 * V and VE are the coastal high-hazard zones where the 1% flood arrives with breaking waves, which
 * is a materially different thing from the riverine A zones. Zone X at its default is *minimal*
 * risk and must never be drawn as a hazard; only its 0.2%-annual-chance subtype is a zone at all.
 */
const ZONE_CLASSES: Readonly<Record<string, HazardClass>> = {
  V: 'extreme',
  VE: 'extreme',
  A: 'high',
  AE: 'high',
  AH: 'high',
  AO: 'high',
  AR: 'high',
  A99: 'high',
  D: 'unclassified',
}

const SHADED_X_SUBTYPE = '0.2 PCT ANNUAL CHANCE FLOOD HAZARD'

const classifyZone = (properties: NfhlProperties): HazardClass | null => {
  const zone = (properties.FLD_ZONE ?? '').trim().toUpperCase()
  if (!zone) return null

  const mapped = ZONE_CLASSES[zone]
  if (mapped) return mapped

  if (zone === 'X') {
    const subtype = (properties.ZONE_SUBTY ?? '').trim().toUpperCase()
    return subtype === SHADED_X_SUBTYPE ? 'moderate' : null
  }
  // OPEN WATER, AREA NOT INCLUDED, and anything else are not hazard areas.
  return null
}

/**
 * Depth, only where FEMA actually publishes one.
 *
 * AO zones carry a sheet-flow depth in feet. Everything else carries STATIC_BFE, which is a base
 * flood *elevation* above datum — not a depth above ground — and reporting it as a depth band would
 * tell someone the water will be 30 m deep because their town sits 30 m above sea level.
 */
const depthOf = (properties: NfhlProperties): DepthBand | undefined => {
  const zone = (properties.FLD_ZONE ?? '').trim().toUpperCase()
  if (zone !== 'AO' || properties.DEPTH == null || !Number.isFinite(properties.DEPTH)) {
    return undefined
  }
  const metres = properties.DEPTH * 0.3048
  return { minMetres: 0, maxMetres: Math.round(metres * 10) / 10 }
}

/** NFHL layer 28 is the flood hazard zone polygon layer. */
export const NFHL_QUERY_URL = (at: LonLat, radiusKm: number, limit = 60): string => {
  const [minLon, minLat, maxLon, maxLat] = createCircleBBox(at, radiusKm)
  const geometry = JSON.stringify({
    xmin: Number(minLon.toFixed(5)),
    ymin: Number(minLat.toFixed(5)),
    xmax: Number(maxLon.toFixed(5)),
    ymax: Number(maxLat.toFixed(5)),
    spatialReference: { wkid: 4326 },
  })
  const params = new URLSearchParams({
    geometry,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'FLD_ZONE,ZONE_SUBTY,DEPTH,STATIC_BFE',
    returnGeometry: 'true',
    resultRecordCount: String(limit),
    f: 'geojson',
  })
  return `https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query?${params.toString()}`
}

/**
 * Regulatory flood hazard areas from FEMA's National Flood Hazard Layer, for anywhere in the US.
 *
 * NFHL is a *scenario* product: it maps the 1%- and 0.2%-annual-chance floodplains as adopted on
 * the effective FIRM, with no valid time and no forecast in it. That distinction is carried through
 * to `ZoneKind` so a summary can never present it as "the flood that is coming".
 *
 * Known limitation: `hazards.fema.gov` was not reachable from the environment this was written in,
 * so this adapter is built to FEMA's published ArcGIS REST contract and tested against payloads in
 * that shape, but has not been exercised against the live service. The NFHL host is on the proxy
 * allowlist and the failure path reports a source failure rather than an empty map.
 */
export class UsFloodScenarioProvider implements FloodDataPort {
  readonly sourceId = 'us.fema.nfhl'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'FEMA National Flood Hazard Layer (NFHL)',
    docsUrl: 'https://hazards.fema.gov/femaportal/wps/portal/NFHLWMS',
    vintage: '2026-08',
    licence: 'U.S. Public Domain',
    attribution: 'Federal Emergency Management Agency (FEMA) National Flood Hazard Layer',
    expectedRefreshMs: 86_400_000 * 180,
  }

  private readonly fixture = new FixtureFloodProvider('us')
  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, GeoError> {
    return fetchViaProxy(this.fetchImpl, {
      kind: 'flood',
      at: query.at,
      sourceId: this.sourceId,
      upstreamUrl: NFHL_QUERY_URL(query.at, query.radiusKm),
      radiusKm: query.radiusKm,
      signal: query.signal,
    }).pipe(
      Effect.flatMap((response) => {
        if (response.servedFromFixture) return this.fixture.zonesWithin(query)

        return parseUpstreamJson<NfhlPayload>(this.sourceId, response.text).pipe(
          Effect.map((payload) =>
            this.toResult(payload, query, {
              cacheHit: response.cacheHit,
              cacheAgeMs: response.cacheAgeMs,
            }),
          ),
        )
      }),
    )
  }

  private toResult(
    payload: NfhlPayload,
    query: FloodQuery,
    cache: { readonly cacheHit: boolean; readonly cacheAgeMs: number },
  ): FloodQueryResult {
    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: NFHL_QUERY_URL(query.at, query.radiusKm),
      datasetVintage: this.meta.vintage,
      retrievedAt: Date.now(),
      cache: { hit: cache.cacheHit, ageMs: cache.cacheAgeMs },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'live',
    }

    // NFHL is an adopted regulatory map, never a forecast.
    const kind: ZoneKind = { kind: 'scenario', designEvent: 'FEMA FIRM 1% / 0.2% annual chance' }

    const zones: Array<FloodZone> = []
    let skipped = 0

    for (const feature of payload.features ?? []) {
      const geometry = feature.geometry
      if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue

      const properties = feature.properties ?? {}
      const hazardClass = classifyZone(properties)
      if (!hazardClass) {
        skipped++
        continue
      }

      zones.push({
        id: `nfhl-${feature.id ?? zones.length}-${properties.FLD_ZONE ?? 'zone'}`,
        kind,
        hazardClass,
        depth: depthOf(properties),
        geometry,
        provenance,
      })
    }

    return {
      zones,
      coverage: this.describeCoverage(zones.length, skipped, query.radiusKm),
      staleness: { stale: false },
    }
  }

  private describeCoverage(zoneCount: number, skipped: number, radiusKm: number): Coverage {
    if (zoneCount === 0) {
      return {
        state: 'full',
        detail:
          skipped > 0
            ? `FEMA maps no 1% or 0.2% annual-chance flood hazard within ${radiusKm} km; the ${skipped} area(s) here are Zone X (minimal risk) or open water.`
            : `FEMA publishes no mapped flood hazard area within ${radiusKm} km of this location. Not every community has an effective FIRM — absence here is not proof of safety.`,
        failedSources: [],
      }
    }
    return { state: 'full', failedSources: [] }
  }
}

/**
 * Kept as a named export because the registry lists a forecast and a scenario source for the US.
 *
 * NWS river-flood *forecast* inundation is published as gridded AHPS products rather than as a
 * point-queryable zone service, so there is no honest live forecast provider here yet. Reporting
 * the scenario map twice — once labelled "forecast" — is exactly the mislabelling this work set out
 * to remove, so this stays on the recorded fixture and says so through its provenance.
 */
export class UsFloodForecastProvider implements FloodDataPort {
  readonly sourceId = 'us.fixture.flood-forecast'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'Simulated US Flood Forecast (no live source wired)',
    docsUrl: 'https://water.noaa.gov/',
    licence: 'Fixture Test Data',
    attribution: 'Simulated US flood forecast — NOT a National Weather Service product',
    expectedRefreshMs: 3600_000,
  }

  private readonly fixture = new FixtureFloodProvider('us')

  zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, GeoError> {
    return this.fixture.zonesWithin(query).pipe(
      Effect.map((res) => ({
        ...res,
        zones: res.zones.filter((z) => z.kind.kind === 'forecast'),
      })),
    )
  }
}
