/**
 * The four hindcast events, and where their observed extents come from.
 *
 * These are the exact archives behind every accuracy figure in
 * docs/specs/flood-model/. Sizes are asserted on download: GSI reissues a file
 * under the same URL from time to time, and a reference that changed silently
 * would move every score in the specs with nothing to show why.
 */

/** A published archive: GSI's, for the Japanese events. */
export interface ArchiveSource {
  readonly kind: 'archive'
  readonly url: string
  readonly zipBytes: number
  /**
   * Path inside the extracted archive. Japanese filenames must survive
   * extraction — `ditto -x -k` on macOS, `unzip -O UTF-8` elsewhere.
   */
  readonly file: string
  readonly format: 'kml-linestring' | 'geojson'
}

/**
 * England's Environment Agency Recorded Flood Outlines, over WFS.
 *
 * The European equivalent of GSI's surveys, and the reason this harness can say
 * anything about Europe at all. It is a live query rather than an archive, so
 * there is no byte-size check to make — the area assertion in `loadObserved` is
 * what stands in for it, and it is the check that actually matters.
 *
 * Filtered to one event by date window and bounding box together: the dataset
 * holds 31 696 outlines and some are national-scale records covering every
 * river that flooded in a month, so a date alone selects half of England.
 *
 * **Only `data_src = Survey` outlines are scored.** The dataset also carries
 * modelled and reconstructed extents, and scoring this model against somebody
 * else's model would be circular.
 */
export interface EaWfsSource {
  readonly kind: 'ea-wfs'
  /** Query window, [minLon, minLat, maxLon, maxLat]. */
  readonly bbox: readonly [number, number, number, number]
  /** Inclusive `start_date` window, ISO dates. */
  readonly from: string
  readonly to: string
}

export type ObservedSource = ArchiveSource | EaWfsSource

export interface HindcastEvent {
  readonly id: string
  readonly label: string
  /** Event rainfall and duration the model is driven with (design.md §5). */
  readonly rainfallMm: number
  readonly durationHours: number
  readonly radiusKm: number
  /** Observed area in km², asserted after parsing. */
  readonly observedAreaKm2: number
  readonly source: ObservedSource
}

export const EVENTS: ReadonlyArray<HindcastEvent> = [
  {
    id: 'joso',
    label: '2015 Kinugawa, Joso',
    rainfallMm: 490,
    durationHours: 48,
    radiusKm: 20,
    observedAreaKm2: 35.8,
    source: {
      kind: 'archive',
      url: 'https://www.gsi.go.jp/common/000205781.zip',
      zipBytes: 61_003,
      file: '国土地理院技術資料D1-No_917_平成27年9月関東・東北豪雨に係る茨城県常総地区推定浸水範囲/常総地区の推定浸水範囲_201509111000.kml',
      format: 'kml-linestring',
    },
  },
  {
    id: 'mabi',
    label: '2018 Oda R., Mabi',
    rainfallMm: 342,
    durationHours: 72,
    radiusKm: 20,
    observedAreaKm2: 8.9,
    source: {
      kind: 'archive',
      url: 'https://www.gsi.go.jp/common/000216844.zip',
      zipBytes: 34_860,
      file: '国土地理院技術資料 D1-No_940 平成30年7月豪雨に係る岡山県倉敷市真備町の推定浸水範囲の変化/国土地理院技術資料 D1-No_940 平成30年7月豪雨に係る岡山県倉敷市真備町の推定浸水範囲の変化_20180707.geojson',
      format: 'geojson',
    },
  },
  {
    id: 'nagano',
    label: '2019 Chikuma, Nagano',
    rainfallMm: 196.8,
    durationHours: 48,
    radiusKm: 20,
    observedAreaKm2: 20.1,
    source: {
      kind: 'archive',
      url: 'https://www1.gsi.go.jp/geowww/201910/shinsui/shinsui_rinkaku.zip',
      zipBytes: 5_330_283,
      file: '浸水推定段彩図の浸水範囲の輪郭線/信濃川水系（千曲川）_20191018/信濃川水系（千曲川）_20191018.geojson',
      format: 'geojson',
    },
  },
  {
    id: 'kuma',
    label: '2020 Kuma R., Hitoyoshi',
    rainfallMm: 322,
    durationHours: 12,
    radiusKm: 20,
    observedAreaKm2: 4.8,
    source: {
      kind: 'archive',
      url: 'https://www1.gsi.go.jp/geowww/saigai/202007/shinsui/shinsui_rinkaku.zip',
      zipBytes: 49_622,
      file: 'shinsui_rinkaku_hitoyoshi/球磨川（人吉周辺）_20200704.geojson',
      format: 'geojson',
    },
  },

  /**
   * The two European events.
   *
   * Their rainfall figures are **not** of the same quality as the Japanese ones, and that has to
   * be understood before any score below is read. The Japanese events are driven with the storm
   * totals in the official post-event reports. There is no equivalent machine-readable figure to
   * hand for these, so both are driven with ERA5 daily precipitation at the query centre over the
   * event window — reproducible, and verifiable by anyone with the same archive.
   *
   * ERA5 is a 0.25° reanalysis and **under-catches orographic extremes badly**. Storm Desmond put
   * a UK-record 341 mm in 24 h on Honister Pass, and ERA5 offers 29 mm at Carlisle for the same
   * day. So a score at this forcing measures the *forcing* as much as the model, which is exactly
   * the ambiguity `storm-sweep.ts` exists to break: sweep the rainfall, and see whether hit rate
   * climbs while precision holds (the storm was wrong) or precision collapses as extent grows (the
   * model is wrong). Read `tools/hindcast/eu.ts` output, not these two numbers alone.
   */
  {
    id: 'carlisle',
    label: '2015 R. Eden, Carlisle (Storm Desmond)',
    // ERA5 at 54.895, -2.94: 27 + 6 + 29 mm on 3–5 Dec 2015.
    rainfallMm: 61.9,
    durationHours: 72,
    radiusKm: 20,
    observedAreaKm2: 14.844,
    source: {
      kind: 'ea-wfs',
      bbox: [-3.1, 54.84, -2.83, 54.98],
      from: '2015-12-04',
      to: '2015-12-10',
    },
  },
  {
    id: 'tewkesbury',
    label: '2007 Severn/Avon, Tewkesbury',
    // ERA5 at 51.99, -2.16: 78 + 6 mm on 20–21 Jul 2007.
    rainfallMm: 84.6,
    durationHours: 48,
    radiusKm: 20,
    observedAreaKm2: 51.702,
    source: {
      kind: 'ea-wfs',
      // Wider than the surveyed extent on purpose: the outlines are per-reach, and a box drawn to
      // the town would cut the Avon and Chelt arms out of the same flood.
      bbox: [-2.35, 51.92, -2.02, 52.1],
      from: '2007-07-19',
      to: '2007-08-05',
    },
  },
]

/** The events whose observed extent is a Japanese survey, and the ones that are English. */
export const JP_EVENT_IDS = ['joso', 'mabi', 'nagano', 'kuma'] as const
export const EU_EVENT_IDS = ['carlisle', 'tewkesbury'] as const

export const eventById = (id: string): HindcastEvent => {
  const event = EVENTS.find((e) => e.id === id)
  if (!event) throw new Error(`unknown event: ${id} (have ${EVENTS.map((e) => e.id).join(', ')})`)
  return event
}
