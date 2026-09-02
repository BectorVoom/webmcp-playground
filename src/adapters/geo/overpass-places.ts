import { Effect } from 'effect'
import type { LonLat } from '../../domain/geo'
import type { Coverage, Provenance } from '../../domain/provenance'
import type { FacilityCategory, SafeFacility } from '../../domain/places'
import type { PlacesPort, PlacesQuery, PlacesQueryResult } from '../../ports/Places'
import type { ProviderMeta } from '../../ports/FloodData'
import type { GeoError } from '../../domain/geo-errors'
import { bearingBetween, metresBetween } from '../../lib/geometry/directions'
import { fetchViaProxy, parseUpstreamJson } from './proxy-client'
import { FixturePlacesProvider } from './fixture/fixture-places'
import type { RegionId } from './region'

interface OverpassElement {
  readonly type?: string
  readonly id?: number
  readonly lat?: number
  readonly lon?: number
  readonly center?: { readonly lat?: number; readonly lon?: number }
  readonly tags?: Readonly<Record<string, string>>
}
export interface OverpassPayload {
  readonly elements?: ReadonlyArray<OverpassElement>
}

/**
 * OSM shelter tags that mean somewhere to evacuate to.
 *
 * The bare `amenity=shelter` tag is the trap: in OSM it is overwhelmingly picnic shelters, bus
 * stops, gazebos and smoking huts. Around Fukui station it returns a smoking area and three picnic
 * shelters and not one evacuation site. Offering those as somewhere to go in a flood is worse than
 * offering nothing, so only these `shelter_type` values are accepted.
 */
const EVACUATION_SHELTER_TYPES = 'emergency_shelter|evacuation_shelter|storm_shelter'

const degreesPerKmLat = 1 / 111
const bboxAround = (at: LonLat, radiusKm: number): string => {
  const dLat = radiusKm * degreesPerKmLat
  const dLon = radiusKm / (111 * Math.max(0.01, Math.cos((at.latitude * Math.PI) / 180)))
  return [
    (at.latitude - dLat).toFixed(4),
    (at.longitude - dLon).toFixed(4),
    (at.latitude + dLat).toFixed(4),
    (at.longitude + dLon).toFixed(4),
  ].join(',')
}

export const buildOverpassQuery = (at: LonLat, radiusKm: number, limit: number): string => {
  const box = bboxAround(at, radiusKm)
  return (
    `[out:json][timeout:25];(` +
    `node["emergency"="assembly_point"](${box});` +
    `way["emergency"="assembly_point"](${box});` +
    `node["amenity"="shelter"]["shelter_type"~"^(${EVACUATION_SHELTER_TYPES})$"](${box});` +
    `way["amenity"="shelter"]["shelter_type"~"^(${EVACUATION_SHELTER_TYPES})$"](${box});` +
    `node["amenity"="hospital"](${box});` +
    `way["amenity"="hospital"](${box});` +
    `);out center ${limit};`
  )
}

export const OVERPASS_URL = (query: string): string =>
  `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`

const categoryOf = (tags: Readonly<Record<string, string>>): FacilityCategory | null => {
  if (tags.emergency === 'assembly_point') return 'evacuation_site'
  if (tags.amenity === 'shelter') return 'evacuation_shelter'
  if (tags.amenity === 'hospital') return 'hospital'
  return null
}

const nameOf = (tags: Readonly<Record<string, string>>, category: FacilityCategory): string => {
  const named = tags['name:en'] ?? tags.name
  if (named) return named
  // An unnamed assembly point is still somewhere to go; it just cannot be called anything.
  return category === 'hospital' ? 'Unnamed hospital' : 'Unnamed evacuation point'
}

/**
 * Evacuation points, shelters and hospitals from OpenStreetMap, for anywhere on earth.
 *
 * One provider serves all three regions because Overpass is a single global database with a
 * bounding-box query — there is no per-country endpoint to resolve first, and no coverage cliff at
 * a border. What varies is how completely a given area has been mapped, which is why coverage
 * distinguishes "no evacuation sites are mapped here" from "there are none".
 */
export class OverpassPlacesProvider implements PlacesPort {
  readonly sourceId = 'global.osm.overpass'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'OpenStreetMap (Overpass API)',
    docsUrl: 'https://wiki.openstreetmap.org/wiki/Overpass_API',
    licence: 'ODbL 1.0',
    attribution: '© OpenStreetMap contributors',
    expectedRefreshMs: 86_400_000,
  }

  private readonly fixture: FixturePlacesProvider
  private readonly fetchImpl: typeof fetch

  constructor(region: RegionId = 'jp', fetchImpl?: typeof fetch) {
    this.fixture = new FixturePlacesProvider(region)
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  facilitiesWithin(query: PlacesQuery): Effect.Effect<PlacesQueryResult, GeoError> {
    const limit = query.limit ?? 20
    // Ask for more than we will show: hospitals crowd out assembly points in dense cities, and the
    // ranking that fixes that has to happen after everything is in hand.
    const overpassQuery = buildOverpassQuery(query.at, query.radiusKm, Math.max(limit * 3, 60))

    return fetchViaProxy(this.fetchImpl, {
      kind: 'places',
      at: query.at,
      sourceId: this.sourceId,
      upstreamUrl: OVERPASS_URL(overpassQuery),
      radiusKm: query.radiusKm,
      signal: query.signal,
    }).pipe(
      Effect.flatMap((response) => {
        if (response.servedFromFixture) return this.fixture.facilitiesWithin(query)

        return parseUpstreamJson<OverpassPayload>(this.sourceId, response.text).pipe(
          Effect.map((payload) =>
            this.toResult(payload, query, limit, {
              cacheHit: response.cacheHit,
              cacheAgeMs: response.cacheAgeMs,
            }),
          ),
        )
      }),
    )
  }

  private toResult(
    payload: OverpassPayload,
    query: PlacesQuery,
    limit: number,
    cache: { readonly cacheHit: boolean; readonly cacheAgeMs: number },
  ): PlacesQueryResult {
    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: 'https://overpass-api.de/api/interpreter',
      retrievedAt: Date.now(),
      cache: { hit: cache.cacheHit, ageMs: cache.cacheAgeMs },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'live',
    }

    const facilities: Array<SafeFacility> = []

    for (const element of payload.elements ?? []) {
      const latitude = element.lat ?? element.center?.lat
      const longitude = element.lon ?? element.center?.lon
      if (latitude === undefined || longitude === undefined) continue

      const tags = element.tags ?? {}
      const category = categoryOf(tags)
      if (!category) continue
      if (query.category && category !== query.category) continue

      const at: LonLat = { latitude, longitude }
      const metres = Math.round(metresBetween(query.at, at))
      // Overpass filters on a bounding box; the caller asked for a circle.
      if (metres > query.radiusKm * 1000) continue

      facilities.push({
        id: `osm-${element.type ?? 'node'}-${element.id ?? facilities.length}`,
        name: nameOf(tags, category),
        category,
        at,
        metres,
        bearing: Math.round(bearingBetween(query.at, at)),
        // Assessed against flood zones later, by the snapshot builder.
        risk: 'unknown',
        provenance,
      })
    }

    // Purpose-built evacuation points first, then distance. A hospital is a fallback destination,
    // not the answer to "where do I go", and sorting on distance alone buries the real answer.
    const rank: Record<FacilityCategory, number> = {
      evacuation_site: 0,
      evacuation_shelter: 0,
      public_facility: 1,
      hospital: 2,
    }
    facilities.sort((a, b) => rank[a.category] - rank[b.category] || a.metres - b.metres)

    const capped = facilities.slice(0, limit)
    const evacuationCount = facilities.filter((f) => rank[f.category] === 0).length

    return {
      facilities: capped,
      coverage: this.describeCoverage({
        total: facilities.length,
        omitted: facilities.length - capped.length,
        evacuationCount,
        radiusKm: query.radiusKm,
      }),
      staleness: { stale: false },
    }
  }

  private describeCoverage(counts: {
    readonly total: number
    readonly omitted: number
    readonly evacuationCount: number
    readonly radiusKm: number
  }): Coverage {
    const { total, omitted, evacuationCount, radiusKm } = counts

    if (total === 0) {
      return {
        state: 'none',
        reason: 'no_data_for_area',
        detail: `OpenStreetMap has no mapped evacuation points, emergency shelters or hospitals within ${radiusKm} km of this location. That is a gap in the map, not a statement that none exist — check your local authority's hazard map.`,
        failedSources: [],
      }
    }

    if (evacuationCount === 0) {
      return {
        state: 'partial',
        reason: 'no_data_for_area',
        detail: `No designated evacuation point or emergency shelter is mapped in OpenStreetMap within ${radiusKm} km; the ${total} result(s) here are hospitals. Your local authority's designated evacuation sites are likely to exist but be unmapped.`,
        failedSources: [],
      }
    }

    if (omitted > 0) {
      return {
        state: 'partial',
        reason: 'result_cap',
        detail: `${omitted} of ${total} mapped facilities were omitted to fit the result cap.`,
        failedSources: [],
      }
    }

    return { state: 'full', failedSources: [] }
  }
}
