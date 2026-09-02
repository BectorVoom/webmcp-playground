import type { BBox, LonLat } from '../../../domain/geo'

/**
 * JMA warning-office areas, the unit its warning feed is published in.
 *
 * JMA serves warnings per *office* (`/bosai/warning/data/warning/{code}.json`), not per prefecture.
 * For 45 of the 47 prefectures the two coincide, but Hokkaido is split across 8 offices and Okinawa
 * across 4, and Kagoshima splits its Amami islands out — so the naive "prefecture JIS code + 0000"
 * mapping 404s for exactly the places where a warning is most likely to be a typhoon. The 58 codes
 * and names below are JMA's own, from https://www.jma.go.jp/bosai/common/const/area.json.
 *
 * `area.json` carries no geometry, so the extents here are hand-built from the office boundaries.
 * They are deliberately generous: resolution falls back to the nearest centroid, so an approximate
 * box costs at worst a neighbouring office near a border, while a gap would cost a user their
 * warnings entirely.
 */
export interface JmaOffice {
  readonly code: string
  readonly name: string
  /** One or more extents. Several offices are archipelagos and need more than one. */
  readonly bboxes: ReadonlyArray<BBox>
  /** Representative point, used when no box contains the query. */
  readonly centroid: LonLat
}

const office = (
  code: string,
  name: string,
  centroid: [number, number],
  bboxes: ReadonlyArray<BBox>,
): JmaOffice => ({
  code,
  name,
  bboxes,
  centroid: { longitude: centroid[0], latitude: centroid[1] },
})

export const JMA_OFFICES: ReadonlyArray<JmaOffice> = [
  // --- Hokkaido: eight offices, not one prefecture ---
  office('011000', '宗谷地方', [142.0, 45.1], [[141.4, 44.6, 143.0, 45.6]]),
  office('012000', '上川・留萌地方', [142.2, 44.0], [[141.4, 43.2, 143.2, 45.0]]),
  office('013000', '網走・北見・紋別地方', [144.0, 44.0], [[142.8, 43.3, 145.4, 45.0]]),
  office('014030', '十勝地方', [143.2, 42.9], [[142.3, 42.2, 144.0, 43.5]]),
  office('014100', '釧路・根室地方', [144.8, 43.2], [[143.6, 42.9, 145.9, 43.6]]),
  office('015000', '胆振・日高地方', [142.0, 42.4], [[140.9, 41.9, 143.2, 43.0]]),
  office('016000', '石狩・空知・後志地方', [141.4, 43.2], [[140.3, 42.6, 142.5, 43.9]]),
  office('017000', '渡島・檜山地方', [140.5, 41.9], [[139.7, 41.3, 141.5, 42.6]]),

  // --- Tohoku ---
  office('020000', '青森県', [140.7, 40.8], [[139.5, 40.2, 141.7, 41.6]]),
  office('030000', '岩手県', [141.3, 39.6], [[140.6, 38.7, 142.1, 40.5]]),
  office('040000', '宮城県', [140.9, 38.4], [[140.3, 37.7, 141.7, 39.0]]),
  office('050000', '秋田県', [140.3, 39.7], [[139.6, 38.8, 141.0, 40.5]]),
  office('060000', '山形県', [140.1, 38.4], [[139.5, 37.7, 140.6, 39.2]]),
  office('070000', '福島県', [140.2, 37.4], [[139.1, 36.8, 141.1, 38.0]]),

  // --- Kanto / Koshin ---
  office('080000', '茨城県', [140.3, 36.3], [[139.7, 35.7, 140.9, 36.95]]),
  office('090000', '栃木県', [139.8, 36.7], [[139.3, 36.2, 140.3, 37.15]]),
  office('100000', '群馬県', [139.0, 36.5], [[138.4, 35.9, 139.7, 37.1]]),
  office('110000', '埼玉県', [139.3, 36.0], [[138.7, 35.75, 139.9, 36.3]]),
  office('120000', '千葉県', [140.2, 35.5], [[139.7, 34.9, 140.9, 36.1]]),
  // Tokyo reaches Ogasawara, 1000 km south of the metropolis. One box cannot hold both.
  office('130000', '東京都', [139.6, 35.7], [
    [138.9, 35.5, 139.95, 35.92],
    [138.95, 24.0, 142.4, 34.9],
  ]),
  office('140000', '神奈川県', [139.4, 35.4], [[138.9, 35.1, 139.8, 35.65]]),
  office('190000', '山梨県', [138.6, 35.6], [[138.2, 35.15, 139.15, 35.97]]),
  office('200000', '長野県', [138.0, 36.2], [[137.3, 35.2, 138.75, 37.05]]),

  // --- Hokuriku ---
  office('150000', '新潟県', [138.9, 37.6], [[137.6, 36.7, 139.9, 38.6]]),
  office('160000', '富山県', [137.2, 36.65], [[136.75, 36.3, 137.8, 36.99]]),
  office('170000', '石川県', [136.7, 36.8], [[136.2, 36.0, 137.4, 37.6]]),
  office('180000', '福井県', [136.2, 35.85], [[135.45, 35.3, 136.85, 36.3]]),

  // --- Tokai ---
  office('210000', '岐阜県', [137.0, 35.8], [[136.25, 35.1, 137.7, 36.5]]),
  office('220000', '静岡県', [138.3, 35.0], [[137.4, 34.55, 139.2, 35.7]]),
  office('230000', '愛知県', [137.2, 35.0], [[136.65, 34.55, 137.85, 35.4]]),
  office('240000', '三重県', [136.4, 34.5], [[135.85, 33.7, 136.99, 35.25]]),

  // --- Kinki ---
  office('250000', '滋賀県', [136.1, 35.2], [[135.75, 34.75, 136.5, 35.7]]),
  office('260000', '京都府', [135.5, 35.2], [[134.85, 34.7, 136.05, 35.78]]),
  office('270000', '大阪府', [135.5, 34.65], [[135.1, 34.27, 135.75, 35.05]]),
  office('280000', '兵庫県', [134.8, 35.0], [[134.25, 34.15, 135.47, 35.67]]),
  office('290000', '奈良県', [135.85, 34.35], [[135.55, 33.85, 136.25, 34.78]]),
  office('300000', '和歌山県', [135.4, 33.9], [[134.99, 33.4, 136.1, 34.4]]),

  // --- Chugoku ---
  office('310000', '鳥取県', [133.9, 35.4], [[133.1, 35.05, 134.5, 35.65]]),
  office('320000', '島根県', [132.6, 35.2], [[131.6, 34.3, 133.4, 36.35]]),
  office('330000', '岡山県', [133.9, 34.85], [[133.25, 34.3, 134.45, 35.35]]),
  office('340000', '広島県', [132.7, 34.5], [[132.0, 34.0, 133.5, 35.1]]),
  office('350000', '山口県', [131.5, 34.2], [[130.8, 33.7, 132.25, 34.8]]),

  // --- Shikoku ---
  office('360000', '徳島県', [134.2, 33.9], [[133.6, 33.5, 134.85, 34.25]]),
  office('370000', '香川県', [134.0, 34.3], [[133.4, 34.0, 134.45, 34.6]]),
  office('380000', '愛媛県', [132.9, 33.7], [[132.0, 32.9, 133.7, 34.35]]),
  office('390000', '高知県', [133.4, 33.4], [[132.4, 32.7, 134.35, 33.9]]),

  // --- Kyushu ---
  office('400000', '福岡県', [130.6, 33.5], [[129.9, 33.0, 131.2, 34.0]]),
  office('410000', '佐賀県', [130.2, 33.3], [[129.75, 32.95, 130.55, 33.65]]),
  office('420000', '長崎県', [129.6, 33.0], [[128.0, 32.0, 130.4, 34.8]]),
  office('430000', '熊本県', [130.8, 32.7], [[129.9, 32.1, 131.3, 33.25]]),
  office('440000', '大分県', [131.4, 33.2], [[130.8, 32.7, 132.1, 33.7]]),
  office('450000', '宮崎県', [131.3, 32.1], [[130.7, 31.35, 131.9, 32.85]]),
  office('460100', '鹿児島県（奄美地方除く）', [130.5, 31.5], [[129.3, 29.0, 131.35, 32.3]]),
  office('460040', '奄美地方', [129.4, 28.2], [[128.2, 27.0, 130.2, 28.6]]),

  // --- Okinawa: four offices spread over 1000 km of ocean ---
  office('471000', '沖縄本島地方', [127.8, 26.4], [[126.6, 25.9, 128.5, 27.0]]),
  office('472000', '大東島地方', [131.2, 25.9], [[130.9, 25.7, 131.4, 26.1]]),
  office('473000', '宮古島地方', [125.3, 24.8], [[124.9, 24.55, 125.6, 24.95]]),
  office('474000', '八重山地方', [124.0, 24.4], [[122.8, 24.0, 124.4, 24.65]]),
]

const inBBox = ({ longitude, latitude }: LonLat, [minLon, minLat, maxLon, maxLat]: BBox): boolean =>
  longitude >= minLon && longitude <= maxLon && latitude >= minLat && latitude <= maxLat

/** Squared degree distance. Only ever compared against itself, so the missing cos(lat) is fine. */
const roughDistanceSq = (a: LonLat, b: LonLat): number =>
  (a.longitude - b.longitude) ** 2 + (a.latitude - b.latitude) ** 2

const nearestOffice = (at: LonLat, candidates: ReadonlyArray<JmaOffice>): JmaOffice => {
  let best = candidates[0] ?? JMA_OFFICES[0]!
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

/**
 * The JMA office whose warnings apply at a point.
 *
 * Always answers. The boxes overlap in places and leave gaps over water, so containment narrows the
 * field and the nearest centroid decides — which means a boat off Niigata gets Niigata's warnings
 * rather than an error. Callers still get the office name, so an answer from the wrong side of a
 * prefecture line is visible in the result rather than silent.
 */
export const resolveJmaOffice = (at: LonLat): JmaOffice => {
  const containing = JMA_OFFICES.filter((o) => o.bboxes.some((box) => inBBox(at, box)))
  return nearestOffice(at, containing.length > 0 ? containing : JMA_OFFICES)
}
