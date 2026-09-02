import { Effect } from 'effect'
import type { LonLat } from '../../../domain/geo'
import {
  invalidQueryReason,
  MIN_NAME_MATCH_SCORE,
  scoreNameMatch,
  type GeocodeResultSet,
  type GeocodedPlace,
  type PlaceKind,
} from '../../../domain/geocoding'
import { GeocodeQueryInvalid, type GeoError } from '../../../domain/geo-errors'
import type { Provenance } from '../../../domain/provenance'
import type { GeocodeQuery, GeocodingPort } from '../../../ports/Geocoding'
import type { ProviderMeta } from '../../../ports/FloodData'
import { metresBetween } from '../../../lib/geometry/directions'
import gazetteer from '../../../../fixtures/geo/global/geocode/normal.json'

interface FixturePlaceItem {
  readonly id: string
  readonly name: string
  readonly displayName: string
  readonly aliases: ReadonlyArray<string>
  readonly kind: string
  readonly latitude: number
  readonly longitude: number
  readonly countryCode?: string
}

interface FixtureGeocodeFile {
  readonly upstreamUrl: string
  readonly licence: string
  readonly attribution: string
  readonly places: ReadonlyArray<FixturePlaceItem>
}

/**
 * A closed gazetteer of well-known places, for the offline demo and for tests.
 *
 * It deliberately does not synthesise a result for an unrecognised name, which is what the fixture
 * shelter provider does. A shelter invented near you is still a plausible thing to draw on a map
 * and is labelled simulated; a coordinate invented for "Fukui Station" is a specific claim about
 * where Fukui Station is, and every tool downstream — flood zones, shelters, routes — would answer
 * truthfully about the wrong place. An unknown name resolves to nothing, and says why.
 */
export class FixtureGeocodingProvider implements GeocodingPort {
  readonly sourceId = 'global.fixture.geocode'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'Simulated Gazetteer (Fixture Mode)',
    docsUrl: 'https://example.com/docs/fixture-geocode',
    vintage: '2026-04-fixture',
    licence: 'Fixture Test Data',
    attribution: 'Simulated gazetteer (Fixture Mode)',
    expectedRefreshMs: 86_400_000,
  }

  search(query: GeocodeQuery): Effect.Effect<GeocodeResultSet, GeoError> {
    // The same rule the live geocoder applies, so which provider is selected cannot change whether
    // a caller's mistake is a tagged failure or a silent empty answer.
    const reason = invalidQueryReason(query.text)
    if (reason !== undefined) {
      return Effect.fail(new GeocodeQueryInvalid({ query: query.text ?? '', reason }))
    }

    const file = gazetteer as FixtureGeocodeFile
    const limit = query.limit ?? 5

    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: file.upstreamUrl,
      datasetVintage: '2026-04',
      retrievedAt: Date.now(),
      cache: { hit: false, ageMs: 0 },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'fixture',
    }

    const scored = file.places
      .map((place) => {
        const at: LonLat = { latitude: place.latitude, longitude: place.longitude }
        const confidence = Math.max(
          ...place.aliases.map((alias) => scoreNameMatch(query.text, alias)),
          scoreNameMatch(query.text, place.name),
        )
        return { place, at, confidence }
      })
      .filter((candidate) => candidate.confidence >= MIN_NAME_MATCH_SCORE)
      .sort(
        (a, b) =>
          b.confidence - a.confidence ||
          // Only a tie-break: a nearer place is the likelier reading of an equally good name, but
          // never good enough to outrank a better name match.
          (query.near ? metresBetween(query.near, a.at) - metresBetween(query.near, b.at) : 0),
      )

    const matches: ReadonlyArray<GeocodedPlace> = scored.slice(0, limit).map((candidate) => ({
      id: candidate.place.id,
      name: candidate.place.name,
      displayName: candidate.place.displayName,
      at: candidate.at,
      kind: candidate.place.kind as PlaceKind,
      confidence: candidate.confidence,
      countryCode: candidate.place.countryCode,
      provenance,
    }))

    return Effect.succeed({
      query: query.text,
      matches,
      coverage:
        matches.length > 0
          ? { state: 'full', failedSources: [] }
          : {
              state: 'none',
              reason: 'no_data_for_area',
              detail: `Fixture mode geocodes against a closed list of ${file.places.length} well-known places and "${query.text}" is not one of them. No coordinates were invented for it. Set GEO_DATA_MODE=live to geocode any place name against OpenStreetMap.`,
              failedSources: [],
            },
    })
  }
}
