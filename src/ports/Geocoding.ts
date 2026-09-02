import type { Effect } from 'effect'
import type { LonLat } from '../domain/geo'
import type { GeocodeResultSet } from '../domain/geocoding'
import type { GeoError } from '../domain/geo-errors'
import type { ProviderMeta } from './FloodData'

export interface GeocodeQuery {
  /** The place as a person named it. Never coordinates. */
  readonly text: string
  readonly limit?: number
  /**
   * Bias results towards this point. A hint only — a match far outside it is still returned,
   * because "the nearest Springfield" is a different question from "the Springfield I meant".
   */
  readonly near?: LonLat
  /** BCP 47 tag for the language names come back in. Sources answer in the local language without it. */
  readonly language?: string
  readonly signal?: AbortSignal
}

/**
 * Name to coordinates. Global rather than per-region: a geocoder is what tells you which region
 * you are in, so it cannot be selected by one (R6.2).
 */
export interface GeocodingPort {
  readonly sourceId: string
  readonly meta: ProviderMeta
  readonly search: (query: GeocodeQuery) => Effect.Effect<GeocodeResultSet, GeoError>
}
