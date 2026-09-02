import type { BBox, LonLat } from './geo'
import type { Coverage, Provenance } from './provenance'

/**
 * Forward geocoding: a place as a person names it ("Fukui Station", "福井駅") resolved to a point
 * on the earth.
 *
 * This is the inverse of everything else in the geo domain, which starts from coordinates. It
 * exists because the device's position answers "am I safe" and nothing else: "is my daughter's
 * school in the flood zone" needs a name turned into a latitude and longitude first, and a model
 * asked to do that from memory will confidently produce a plausible, wrong pair of numbers.
 */

export type PlaceKind =
  /** Railway, metro, bus or ferry terminal — the most common way people name a location. */
  | 'station'
  /** A populated place: city, town, village, suburb. */
  | 'settlement'
  /** A street address or building number. */
  | 'address'
  /** A named point of interest: school, hospital, park, landmark. */
  | 'poi'
  /** An administrative or natural area rather than a point (prefecture, county, river). */
  | 'area'
  | 'other'

export interface GeocodedPlace {
  readonly id: string
  /** The place's own name, as the source spells it ("福井駅"). */
  readonly name: string
  /** Name plus enough context to tell two like-named places apart ("福井駅, 福井市, 福井県, 日本"). */
  readonly displayName: string
  readonly at: LonLat
  readonly kind: PlaceKind
  /** Extent, where the source publishes one. An area match is not a point however it is reported. */
  readonly bbox?: BBox
  /** 0–1. How well this candidate answers the query, not how accurate its coordinates are. */
  readonly confidence: number
  /** ISO 3166-1 alpha-2, lowercase, where the source gives it. */
  readonly countryCode?: string
  readonly provenance: Provenance
}

export interface GeocodeResultSet {
  /** The query as asked, so a caller can quote it back without keeping it alongside. */
  readonly query: string
  /** Best first. Empty is a legitimate answer, described by `coverage` (ADR-3). */
  readonly matches: ReadonlyArray<GeocodedPlace>
  readonly coverage: Coverage
}

/**
 * Folds away the differences that never distinguish two place names: full-width vs half-width
 * (Japanese input methods emit either), case, runs of whitespace including U+3000, and the
 * punctuation that separates address parts.
 */
export const normalisePlaceQuery = (raw: string): string =>
  raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.,'"`·・、。()[\]（）「」]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Below this a candidate is noise, not a weak match, and is dropped rather than ranked last. */
export const MIN_NAME_MATCH_SCORE = 0.4

/**
 * How well a candidate name answers a query, from 1 (the same name) down to 0 (unrelated).
 *
 * Substring containment carries most of the weight because it is what actually happens: people
 * type "Fukui Station" for "Fukui Station (JR West)" and "福井駅" for "福井駅, 福井市, 福井県".
 * Token overlap catches the reordered latin case ("Station Fukui") that containment misses;
 * Japanese needs no such rule because it is written without spaces and containment covers it.
 */
export const scoreNameMatch = (query: string, candidate: string): number => {
  const q = normalisePlaceQuery(query)
  const c = normalisePlaceQuery(candidate)
  if (q === '' || c === '') return 0
  if (q === c) return 1

  if (c.startsWith(q) || q.startsWith(c)) return 0.85
  if (c.includes(q) || q.includes(c)) return 0.7

  const qTokens = q.split(' ').filter(Boolean)
  const cTokens = new Set(c.split(' ').filter(Boolean))
  if (qTokens.length === 0 || cTokens.size === 0) return 0
  const overlap = qTokens.filter((token) => cTokens.has(token)).length
  if (overlap === 0) return 0
  // Scaled against the longer side, so "tokyo" against "tokyo station east exit plaza" does not
  // score as highly as against "tokyo station".
  return 0.65 * (overlap / Math.max(qTokens.length, cTokens.size))
}

/** A pair of numbers, however spaced or signed — what a caller pastes when it already has the answer. */
const COORDINATE_PAIR = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/

/**
 * Why this query cannot be geocoded at all, or `undefined` if it can.
 *
 * Shared by every provider so the port's contract is one rule rather than one per adapter: a
 * caller must get the same tagged failure whichever geocoder happens to be selected.
 */
export const invalidQueryReason = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim() ?? ''
  if (trimmed === '') return 'the query is empty'
  if (COORDINATE_PAIR.test(trimmed)) {
    return 'it is a coordinate pair, not a place name; pass it straight to the tool that needs coordinates'
  }
  return undefined
}

export const describeConfidence = (confidence: number): 'high' | 'moderate' | 'low' =>
  confidence >= 0.75 ? 'high' : confidence >= 0.5 ? 'moderate' : 'low'

/**
 * Whether the top two candidates answer the query about equally well.
 *
 * "Springfield" matches dozens of towns almost equally well, and picking the first silently sends
 * an evacuation query a thousand kilometres from where the user meant.
 *
 * This is deliberately only the confidence half of the question. Whether a near-tie actually
 * matters is geographic — two names for the same station 160 m apart are a tie that changes no
 * answer — and that judgement belongs to the caller that can measure the distance.
 */
export const isAmbiguous = (matches: ReadonlyArray<GeocodedPlace>): boolean => {
  const [first, second] = matches
  if (!first || !second) return false
  return first.confidence - second.confidence < 0.1
}
