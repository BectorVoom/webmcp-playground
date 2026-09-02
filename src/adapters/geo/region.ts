import { Effect } from 'effect'
import type { BBox, LonLat } from '../../domain/geo'
import { RegionUnsupported } from '../../domain/geo-errors'

export type RegionId = 'us' | 'eu' | 'jp'

export interface RegionRule {
  readonly id: RegionId
  readonly name: string
  readonly note: string
  readonly authority: string
  readonly bboxes: ReadonlyArray<BBox>
}

/**
 * Region rules as declarative data with source notes (Design §5, R6.2, R6.3).
 * No nearest-region fallback is ever performed (R6.3).
 */
export const REGION_RULES: ReadonlyArray<RegionRule> = [
  {
    id: 'jp',
    name: 'Japan',
    authority: 'JMA and your local government',
    note: 'Covers Japanese main archipelago (Honshu, Hokkaido, Kyushu, Shikoku), Ryukyu/Okinawa, and Izu/Ogasawara (GSI/JMA coverage).',
    bboxes: [
      [128.5, 30.0, 146.0, 46.0], // Main archipelago (Kyushu, Shikoku, Honshu, Hokkaido)
      [122.5, 24.0, 131.5, 30.0], // Ryukyu / Okinawa islands
      [139.0, 20.0, 143.0, 30.0], // Ogasawara / Izu islands
    ],
  },
  {
    id: 'us',
    name: 'United States',
    authority: 'NWS, FEMA, and local emergency management',
    note: 'Covers Conterminous US, Alaska, Hawaii, and Puerto Rico (NWS/FEMA bounds).',
    bboxes: [
      [-125.0, 24.0, -66.0, 50.0], // Lower 48 States
      [-180.0, 51.0, -129.0, 72.0], // Alaska
      [-161.0, 18.0, -154.0, 23.0], // Hawaii
      [-68.0, 17.5, -65.0, 19.0], // Puerto Rico & USVI
    ],
  },
  {
    id: 'eu',
    name: 'Europe',
    authority: 'National civil protection and meteorological agencies',
    note: 'Covers European mainland, UK, Ireland, Scandinavia, and Mediterranean (Copernicus/MeteoAlarm coverage).',
    bboxes: [
      [-25.0, 34.0, 40.0, 72.0], // European continent, UK, Scandinavia
    ],
  },
]

export const SUPPORTED_REGIONS: ReadonlyArray<RegionId> = ['us', 'eu', 'jp']

const inBBox = (coords: LonLat, [minLon, minLat, maxLon, maxLat]: BBox): boolean =>
  coords.longitude >= minLon &&
  coords.longitude <= maxLon &&
  coords.latitude >= minLat &&
  coords.latitude <= maxLat

export interface ResolvedRegion {
  readonly region: RegionId
  readonly rule: RegionRule
}

/**
 * The region containing a point, or `undefined` where none does. For callers that treat "outside
 * every supported region" as a fact to report rather than a failure to propagate — a geocoder,
 * most obviously, which can legitimately resolve a place nothing else here has data for.
 */
export const findRegion = (coords: LonLat): ResolvedRegion | undefined => {
  for (const rule of REGION_RULES) {
    if (rule.bboxes.some((box) => inBBox(coords, box))) {
      return { region: rule.id, rule }
    }
  }
  return undefined
}

export const resolveRegion = (
  coords: LonLat,
): Effect.Effect<ResolvedRegion, RegionUnsupported> => {
  const found = findRegion(coords)
  if (found) return Effect.succeed(found)

  return Effect.fail(
    new RegionUnsupported({
      coordinates: coords,
      supportedRegions: SUPPORTED_REGIONS,
    }),
  )
}
