import { Effect } from 'effect'
import type { BBox, LonLat } from '../../domain/geo'
import { GeocodeQueryInvalid, type GeoError } from '../../domain/geo-errors'
import {
  invalidQueryReason,
  type GeocodeResultSet,
  type GeocodedPlace,
  type PlaceKind,
} from '../../domain/geocoding'
import type { Provenance } from '../../domain/provenance'
import type { ProviderMeta } from '../../ports/FloodData'
import type { GeocodeQuery, GeocodingPort } from '../../ports/Geocoding'
import { FixtureGeocodingProvider } from './fixture/fixture-geocoding'
import { fetchViaProxy, parseUpstreamJson } from './proxy-client'

/** The `jsonv2` search response. Every field is optional because Nominatim omits, not nulls. */
interface NominatimItem {
  readonly place_id?: number
  readonly osm_type?: string
  readonly osm_id?: number
  readonly lat?: string
  readonly lon?: string
  /** OSM key, e.g. `railway`, `place`, `amenity`. */
  readonly category?: string
  /** OSM value, e.g. `station`, `city`, `hospital`. */
  readonly type?: string
  readonly addresstype?: string
  readonly name?: string
  readonly display_name?: string
  /** Global prominence, roughly 0–1. Not a match score; see `relativeConfidence`. */
  readonly importance?: number
  /** [minLat, maxLat, minLon, maxLat] as strings — note the order is not GeoJSON's. */
  readonly boundingbox?: ReadonlyArray<string>
  readonly address?: { readonly country_code?: string }
}

export type NominatimPayload = ReadonlyArray<NominatimItem>

export const NOMINATIM_HOST = 'https://nominatim.openstreetmap.org'

/** Nominatim's usage policy asks for a bounded result count; more than this is abuse, not detail. */
const MAX_LIMIT = 10
const MAX_QUERY_LENGTH = 200

/** A viewbox is `lon,lat,lon,lat`. Roughly 50 km at the equator, narrowing with latitude. */
const VIEWBOX_DEGREES = 0.45

export const buildNominatimUrl = (query: GeocodeQuery): string => {
  const params = new URLSearchParams({
    q: query.text.trim().slice(0, MAX_QUERY_LENGTH),
    format: 'jsonv2',
    addressdetails: '1',
    limit: String(Math.min(Math.max(query.limit ?? 5, 1), MAX_LIMIT)),
  })
  if (query.language) params.set('accept-language', query.language)
  if (query.near) {
    const { longitude, latitude } = query.near
    params.set(
      'viewbox',
      [
        longitude - VIEWBOX_DEGREES,
        latitude - VIEWBOX_DEGREES,
        longitude + VIEWBOX_DEGREES,
        latitude + VIEWBOX_DEGREES,
      ]
        .map((value) => value.toFixed(4))
        .join(','),
    )
    // Bias, never a filter: a user who asks for "Fukui Station" from Tokyo means the one in Fukui.
    params.set('bounded', '0')
  }
  return `${NOMINATIM_HOST}/search?${params.toString()}`
}

/**
 * OSM's tagging vocabulary, reduced to the handful of kinds a reader cares about.
 *
 * The distinction that matters is point versus area: a `boundary`/`place=city` match resolves to a
 * label point somewhere inside a region tens of kilometres across, and treating that as "where the
 * user is" quietly moves them. `kind: 'area'` is what lets the caller say so.
 */
export const classifyPlace = (item: NominatimItem): PlaceKind => {
  const category = item.category ?? ''
  const type = item.type ?? ''
  const addressType = item.addresstype ?? ''

  if (category === 'public_transport') return 'station'
  if (category === 'railway' && ['station', 'halt', 'stop', 'tram_stop'].includes(type)) return 'station'
  // A mapped station building is still a station. Nominatim returns this shape for Aomori Station
  // (`building=train_station`) instead of the more usual `railway=station` node.
  if (category === 'building' && type === 'train_station') return 'station'
  if (category === 'aeroway' && ['aerodrome', 'terminal'].includes(type)) return 'station'
  if (type === 'bus_station' || type === 'ferry_terminal') return 'station'
  if (category === 'place') {
    if (['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'quarter'].includes(type)) {
      return 'settlement'
    }
    if (type === 'house' || addressType === 'house_number') return 'address'
    return 'area'
  }
  if (category === 'boundary' || category === 'natural' || category === 'waterway') return 'area'
  if (category === 'highway' || addressType === 'road' || addressType === 'house_number') {
    return 'address'
  }
  if (category === '') return 'other'
  return 'poi'
}

const toBBox = (boundingbox: ReadonlyArray<string> | undefined): BBox | undefined => {
  if (!boundingbox || boundingbox.length !== 4) return undefined
  // Nominatim publishes [minLat, maxLat, minLon, maxLon]; a BBox is [minLon, minLat, maxLon, maxLat].
  const [minLat, maxLat, minLon, maxLon] = boundingbox.map(Number)
  if (
    minLat === undefined ||
    maxLat === undefined ||
    minLon === undefined ||
    maxLon === undefined ||
    ![minLat, maxLat, minLon, maxLon].every(Number.isFinite)
  ) {
    return undefined
  }
  return [minLon, minLat, maxLon, maxLat]
}

/**
 * Confidence, relative to the best candidate for the same query.
 *
 * Nominatim's `importance` is global prominence, so read absolutely it would call a real station
 * "low confidence" merely for being smaller than a capital city. Note that this is a different axis
 * from the order the matches come back in, which is Nominatim's own ranking and weighs how well
 * each candidate matches the query as well as how prominent it is; the two can disagree partway
 * down a list. The order is left as the source ranked it, because it is the better ranking. What the caller actually needs is
 * whether the runner-up is nearly as good an answer — three equally prominent Springfields must
 * read as ambiguous, and a clear winner must not. Scoring each candidate against the top one says
 * exactly that. Where `importance` is missing the position Nominatim returned it in stands in.
 */
export const relativeConfidence = (
  importance: number | undefined,
  topImportance: number | undefined,
  index: number,
): number => {
  if (
    importance !== undefined &&
    Number.isFinite(importance) &&
    topImportance !== undefined &&
    Number.isFinite(topImportance) &&
    topImportance > 0
  ) {
    // Floored, not merely rounded: a candidate the source did return is a weak answer, never a
    // zero-confidence non-answer, and 2 dp alone rounds the weakest ones to exactly that.
    const scaled = Math.min(1, Math.max(0, importance / topImportance)) * 0.95
    return Math.max(0.01, Math.round(scaled * 100) / 100)
  }
  return Math.max(0.3, Math.round((0.9 - index * 0.12) * 100) / 100)
}

/**
 * Forward geocoding against OpenStreetMap's Nominatim, for anywhere on earth.
 *
 * Nominatim rather than a commercial geocoder because it needs no key — the one thing that decides
 * whether this works for someone who just cloned the repository. Its usage policy is the cost:
 * roughly one request a second, and no bulk work, which is why the server caches aggressively
 * (place coordinates change on the timescale of construction projects, not minutes) and why the
 * result limit is capped here rather than trusted from the caller.
 */
export class NominatimGeocodingProvider implements GeocodingPort {
  readonly sourceId = 'global.osm.nominatim'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'OpenStreetMap Nominatim',
    docsUrl: 'https://nominatim.org/release-docs/latest/api/Search/',
    licence: 'ODbL 1.0',
    attribution: '© OpenStreetMap contributors',
    expectedRefreshMs: 86_400_000,
  }

  private readonly fixture = new FixtureGeocodingProvider()
  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  search(query: GeocodeQuery): Effect.Effect<GeocodeResultSet, GeoError> {
    // Coordinates in the name field mean the caller already has what it is asking for, and
    // Nominatim would answer with whatever happens to be nearest — a plausible wrong answer.
    const reason = invalidQueryReason(query.text)
    if (reason !== undefined) {
      return Effect.fail(new GeocodeQueryInvalid({ query: query.text ?? '', reason }))
    }
    const text = query.text.trim()

    const normalised: GeocodeQuery = { ...query, text }

    return fetchViaProxy(this.fetchImpl, {
      kind: 'geocode',
      sourceId: this.sourceId,
      upstreamUrl: buildNominatimUrl(normalised),
      searchQuery: text,
      at: query.near,
      signal: query.signal,
    }).pipe(
      Effect.flatMap((response) => {
        if (response.servedFromFixture) return this.fixture.search(normalised)

        return parseUpstreamJson<NominatimPayload>(this.sourceId, response.text).pipe(
          Effect.map((payload) =>
            this.toResult(payload, normalised, {
              cacheHit: response.cacheHit,
              cacheAgeMs: response.cacheAgeMs,
            }),
          ),
        )
      }),
    )
  }

  private toResult(
    payload: NominatimPayload,
    query: GeocodeQuery,
    cache: { readonly cacheHit: boolean; readonly cacheAgeMs: number },
  ): GeocodeResultSet {
    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: `${NOMINATIM_HOST}/search`,
      retrievedAt: Date.now(),
      cache: { hit: cache.cacheHit, ageMs: cache.cacheAgeMs },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'live',
    }

    // Nominatim returns an object, not an array, when it fails — a body in the wrong shape must
    // read as "no matches", never as a crash mid-answer.
    const items = Array.isArray(payload) ? payload : []
    const topImportance = items[0]?.importance

    const matches: Array<GeocodedPlace> = []
    for (const [index, item] of items.entries()) {
      const latitude = Number(item.lat)
      const longitude = Number(item.lon)
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue

      const at: LonLat = { latitude, longitude }
      const name = item.name?.trim() || item.display_name?.split(',')[0]?.trim() || query.text
      matches.push({
        id: `osm-${item.osm_type ?? 'node'}-${item.osm_id ?? item.place_id ?? index}`,
        name,
        displayName: item.display_name ?? name,
        at,
        kind: classifyPlace(item),
        bbox: toBBox(item.boundingbox),
        confidence: relativeConfidence(item.importance, topImportance, index),
        countryCode: item.address?.country_code?.toLowerCase(),
        provenance,
      })
    }

    return {
      query: query.text,
      matches,
      coverage:
        matches.length > 0
          ? { state: 'full', failedSources: [] }
          : {
              state: 'none',
              reason: 'no_data_for_area',
              detail: `OpenStreetMap has no place matching "${query.text}". Check the spelling, or add the town or country ("Fukui Station, Japan").`,
              failedSources: [],
            },
    }
  }
}
