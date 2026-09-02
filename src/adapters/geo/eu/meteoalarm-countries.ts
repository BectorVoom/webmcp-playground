import type { BBox, LonLat } from '../../../domain/geo'

/**
 * The countries MeteoAlarm publishes for, and the feed slug each one answers to.
 *
 * MeteoAlarm has no point query — it publishes one feed per participating country — so a European
 * location has to be resolved to a country before anything can be fetched. Every slug here was
 * checked against `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-{slug}`; note that
 * North Macedonia answers only to `republic-of-north-macedonia`.
 *
 * Extents are approximate and overlap freely — Europe is dense — so resolution narrows by
 * containment and then takes the nearest centroid, exactly as the JMA office table does.
 */
export interface MeteoAlarmCountry {
  readonly slug: string
  readonly name: string
  readonly bboxes: ReadonlyArray<BBox>
  readonly centroid: LonLat
}

const country = (
  slug: string,
  name: string,
  centroid: [number, number],
  bboxes: ReadonlyArray<BBox>,
): MeteoAlarmCountry => ({
  slug,
  name,
  bboxes,
  centroid: { longitude: centroid[0], latitude: centroid[1] },
})

export const METEOALARM_COUNTRIES: ReadonlyArray<MeteoAlarmCountry> = [
  country('austria', 'Austria', [13.3, 47.7], [[9.5, 46.4, 17.2, 49.1]]),
  country('belgium', 'Belgium', [4.5, 50.6], [[2.5, 49.5, 6.4, 51.5]]),
  country('bosnia-herzegovina', 'Bosnia and Herzegovina', [17.8, 44.0], [[15.7, 42.5, 19.6, 45.3]]),
  country('bulgaria', 'Bulgaria', [25.5, 42.7], [[22.3, 41.2, 28.6, 44.2]]),
  country('croatia', 'Croatia', [16.4, 45.1], [[13.4, 42.3, 19.4, 46.6]]),
  country('cyprus', 'Cyprus', [33.2, 35.1], [[32.2, 34.5, 34.6, 35.7]]),
  country('czechia', 'Czechia', [15.5, 49.8], [[12.0, 48.5, 18.9, 51.1]]),
  country('denmark', 'Denmark', [10.0, 56.0], [[8.0, 54.5, 15.2, 57.8]]),
  country('estonia', 'Estonia', [25.0, 58.6], [[21.7, 57.5, 28.2, 59.7]]),
  country('finland', 'Finland', [26.0, 64.5], [[19.0, 59.7, 31.6, 70.1]]),
  country('france', 'France', [2.5, 46.6], [[-5.2, 41.3, 9.6, 51.1]]),
  country('germany', 'Germany', [10.4, 51.2], [[5.8, 47.2, 15.1, 55.1]]),
  country('greece', 'Greece', [23.7, 39.0], [[19.3, 34.8, 29.7, 41.8]]),
  country('hungary', 'Hungary', [19.5, 47.2], [[16.1, 45.7, 22.9, 48.6]]),
  country('iceland', 'Iceland', [-19.0, 64.9], [[-24.6, 63.2, -13.4, 66.6]]),
  country('ireland', 'Ireland', [-8.0, 53.4], [[-10.6, 51.4, -5.9, 55.4]]),
  country('israel', 'Israel', [35.0, 31.5], [[34.2, 29.4, 35.9, 33.3]]),
  country('italy', 'Italy', [12.5, 42.5], [[6.6, 35.4, 18.6, 47.1]]),
  country('latvia', 'Latvia', [24.6, 56.9], [[20.9, 55.6, 28.3, 58.1]]),
  country('lithuania', 'Lithuania', [23.9, 55.2], [[20.9, 53.8, 26.9, 56.5]]),
  country('luxembourg', 'Luxembourg', [6.1, 49.8], [[5.7, 49.4, 6.6, 50.2]]),
  country('malta', 'Malta', [14.4, 35.9], [[14.1, 35.7, 14.6, 36.1]]),
  country('moldova', 'Moldova', [28.5, 47.0], [[26.6, 45.4, 30.2, 48.5]]),
  country('montenegro', 'Montenegro', [19.3, 42.8], [[18.4, 41.8, 20.4, 43.6]]),
  country('netherlands', 'Netherlands', [5.3, 52.2], [[3.3, 50.7, 7.3, 53.6]]),
  country('republic-of-north-macedonia', 'North Macedonia', [21.7, 41.6], [[20.4, 40.8, 23.1, 42.4]]),
  country('norway', 'Norway', [10.0, 62.0], [[4.0, 57.9, 31.3, 71.4]]),
  country('poland', 'Poland', [19.1, 52.0], [[14.1, 49.0, 24.2, 54.9]]),
  // Mainland, then the Azores and Madeira, which no single box can hold with it.
  country('portugal', 'Portugal', [-8.0, 39.6], [
    [-9.6, 36.9, -6.1, 42.2],
    [-31.3, 36.9, -24.9, 39.8],
    [-17.3, 32.4, -16.2, 33.2],
  ]),
  country('romania', 'Romania', [25.0, 45.9], [[20.2, 43.6, 29.8, 48.3]]),
  country('serbia', 'Serbia', [20.8, 44.2], [[18.8, 42.2, 23.1, 46.2]]),
  country('slovakia', 'Slovakia', [19.7, 48.7], [[16.8, 47.7, 22.6, 49.7]]),
  country('slovenia', 'Slovenia', [14.9, 46.1], [[13.3, 45.4, 16.7, 46.9]]),
  // Mainland, then the Canaries.
  country('spain', 'Spain', [-3.7, 40.3], [
    [-9.4, 35.9, 4.4, 43.9],
    [-18.2, 27.6, -13.3, 29.5],
  ]),
  country('sweden', 'Sweden', [16.0, 62.5], [[10.9, 55.3, 24.2, 69.1]]),
  country('switzerland', 'Switzerland', [8.2, 46.8], [[5.9, 45.8, 10.6, 47.9]]),
  country('ukraine', 'Ukraine', [31.0, 48.4], [[22.1, 44.3, 40.3, 52.4]]),
  country('united-kingdom', 'United Kingdom', [-2.5, 54.0], [[-8.7, 49.8, 2.0, 60.9]]),
]

const inBBox = ({ longitude, latitude }: LonLat, [minLon, minLat, maxLon, maxLat]: BBox): boolean =>
  longitude >= minLon && longitude <= maxLon && latitude >= minLat && latitude <= maxLat

const roughDistanceSq = (a: LonLat, b: LonLat): number =>
  (a.longitude - b.longitude) ** 2 + (a.latitude - b.latitude) ** 2

/** The MeteoAlarm country whose feed covers a point. Always answers, like its JMA counterpart. */
export const resolveMeteoAlarmCountry = (at: LonLat): MeteoAlarmCountry => {
  const containing = METEOALARM_COUNTRIES.filter((c) => c.bboxes.some((box) => inBBox(at, box)))
  const candidates = containing.length > 0 ? containing : METEOALARM_COUNTRIES

  let best = candidates[0]!
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const distance = roughDistanceSq(at, candidate.centroid)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

export const METEOALARM_FEED_URL = (slug: string): string =>
  `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-${slug}`
