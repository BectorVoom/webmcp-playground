/**
 * The observed extents: download, extract, parse, and check.
 *
 * Land GSI never surveyed is "not mapped", never "known dry" — which is why
 * every metric in this harness is computed inside the surveyed footprint and
 * nowhere else.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { HindcastEvent } from './events'
import { EVENTS } from './events'
import {
  PolygonIndex,
  geometryToPolygons,
  polygonBBox,
  totalAreaKm2,
  unionBBox,
  type BBox,
  type Polygon,
} from './geometry'

export const CACHE_DIR = '.cache/hindcast'

/** A point GSI surveyed and labelled — a levee breach, or an overtopping site. */
export interface FailurePoint {
  readonly kind: 'breach' | 'overflow'
  readonly longitude: number
  readonly latitude: number
}

export interface Observed {
  readonly event: HindcastEvent
  readonly polygons: ReadonlyArray<Polygon>
  readonly index: PolygonIndex
  readonly bbox: BBox
  readonly areaKm2: number
  /** Centre of the observed bounding box — where the model is queried. */
  readonly centre: { readonly longitude: number; readonly latitude: number }
  /** Empty unless the survey recorded them; only Joso's KML does. */
  readonly failurePoints: ReadonlyArray<FailurePoint>
}

const run = (cmd: string, args: ReadonlyArray<string>): void => {
  const result = spawnSync(cmd, [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
}

/**
 * Downloads and extracts anything missing. Idempotent, and the byte-size check
 * is what makes a rebuilt reference trustworthy rather than merely present.
 */
const EA_WFS = 'https://environment.data.gov.uk/spatialdata/recorded-flood-outlines/wfs'
const EA_TYPE = 'dataset-8c75e700-d465-11e4-8b5b-f0def148f590:Recorded_Flood_Outlines'

/**
 * One event's surveyed outlines out of the Environment Agency's 31 696.
 *
 * Three things about this query are deliberate and were each arrived at the hard way:
 *
 * - **`data_src='Survey'`.** The dataset mixes surveyed extents with modelled and reconstructed
 *   ones. Scoring this model against another model would be circular, so only survey is kept.
 * - **`DURING` rather than `>=` and `<=`.** The service sits behind an Azure application gateway
 *   whose WAF answers 403 to a filter combining quoted date comparisons with a second quoted
 *   predicate — it reads as SQL injection. `DURING` expresses the same window and is let through.
 * - **A bounding box as well as a date.** Some outlines are national records covering every river
 *   that flooded in a month, so a date alone selects half of England.
 */
const eaWfsUrl = (source: Extract<HindcastEvent['source'], { kind: 'ea-wfs' }>): string => {
  const [minLon, minLat, maxLon, maxLat] = source.bbox
  const cql =
    `BBOX(shape,${minLon},${minLat},${maxLon},${maxLat},'EPSG:4326')` +
    ` AND start_date DURING ${source.from}T00:00:00Z/${source.to}T00:00:00Z` +
    ` AND data_src='Survey'`
  return `${EA_WFS}?${new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: EA_TYPE,
    outputFormat: 'application/json',
    // The service holds British National Grid and will reproject; asking for 4326 here is what
    // keeps a coordinate transform out of this harness entirely.
    srsName: 'urn:ogc:def:crs:EPSG::4326',
    cql_filter: cql,
  })}`
}

export const fetchObserved = async (events: ReadonlyArray<HindcastEvent> = EVENTS): Promise<void> => {
  await mkdir(join(CACHE_DIR, 'zips'), { recursive: true })
  for (const event of events) {
    if (event.source.kind === 'ea-wfs') {
      const target = join(CACHE_DIR, 'raw', `${event.id}.geojson`)
      if (!existsSync(target)) {
        const response = await fetch(eaWfsUrl(event.source))
        const text = await response.text()
        if (!response.ok || !text.startsWith('{')) {
          throw new Error(`${event.id}: EA WFS answered ${response.status}: ${text.slice(0, 200)}`)
        }
        await mkdir(join(CACHE_DIR, 'raw'), { recursive: true })
        await writeFile(target, text)
      }
      continue
    }
    const zip = join(CACHE_DIR, 'zips', `${event.id}.zip`)
    if (!existsSync(zip)) {
      const response = await fetch(event.source.url)
      if (!response.ok) throw new Error(`${event.id}: ${response.status} from ${event.source.url}`)
      await writeFile(zip, Buffer.from(await response.arrayBuffer()))
    }
    const bytes = (await readFile(zip)).byteLength
    if (bytes !== event.source.zipBytes) {
      throw new Error(
        `${event.id}: archive is ${bytes} B, expected ${event.source.zipBytes} B. ` +
          'GSI reissued the file; re-verify the observed area before trusting any score against it.',
      )
    }
    const dir = join(CACHE_DIR, 'raw', event.id)
    if (!existsSync(join(dir, event.source.file))) {
      await mkdir(dir, { recursive: true })
      if (process.platform === 'darwin') run('ditto', ['-x', '-k', zip, dir])
      else run('unzip', ['-o', '-O', 'UTF-8', zip, '-d', dir])
    }
  }
}

/**
 * GSI's Joso archive draws the extent as open polylines, not polygons: the
 * survey traced the waterline it could see and left it open. Closing each line
 * is the reconstruction, and the area check below is what says it is the right
 * one — it reproduces GSI's published 35.8 km².
 */
const parseKmlLineStrings = (
  xml: string,
): { polygons: ReadonlyArray<Polygon>; failurePoints: ReadonlyArray<FailurePoint> } => {
  const polygons: Array<Polygon> = []
  const failurePoints: Array<FailurePoint> = []
  for (const [, block] of xml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
    const name = /<name>([\s\S]*?)<\/name>/.exec(block)?.[1]?.trim() ?? ''
    const raw = /<coordinates>([\s\S]*?)<\/coordinates>/.exec(block)?.[1] ?? ''
    const points = raw
      .split(/\s+/)
      .filter((token) => token.includes(','))
      .map((token) => {
        const [lon, lat] = token.split(',')
        return [Number(lon), Number(lat)] as const
      })
    if (points.length === 0) continue
    if (name.includes('浸水範囲')) {
      if (points.length >= 3) polygons.push([points])
    } else if (name.includes('破堤')) {
      failurePoints.push({ kind: 'breach', longitude: points[0]![0], latitude: points[0]![1] })
    } else if (name.includes('越水')) {
      failurePoints.push({ kind: 'overflow', longitude: points[0]![0], latitude: points[0]![1] })
    }
  }
  return { polygons, failurePoints }
}

const parseGeoJson = (text: string): ReadonlyArray<Polygon> => {
  const collection = JSON.parse(text) as {
    features: ReadonlyArray<{ geometry: { type: string; coordinates: unknown } | null }>
  }
  return collection.features.flatMap((feature) =>
    feature.geometry ? geometryToPolygons(feature.geometry) : [],
  )
}

export const loadObserved = async (event: HindcastEvent): Promise<Observed> => {
  const path =
    event.source.kind === 'ea-wfs'
      ? join(CACHE_DIR, 'raw', `${event.id}.geojson`)
      : join(CACHE_DIR, 'raw', event.id, event.source.file)
  const text = await readFile(path, 'utf8')
  const parsed =
    event.source.kind === 'archive' && event.source.format === 'kml-linestring'
      ? parseKmlLineStrings(text)
      : { polygons: parseGeoJson(text), failurePoints: [] as ReadonlyArray<FailurePoint> }

  const { polygons, failurePoints } = parsed
  if (polygons.length === 0) throw new Error(`${event.id}: no observed polygons parsed from ${path}`)

  const areaKm2 = totalAreaKm2(polygons)
  const drift = Math.abs(areaKm2 - event.observedAreaKm2)
  if (drift > 0.1) {
    throw new Error(
      `${event.id}: parsed observed area ${areaKm2.toFixed(2)} km² but the specs record ` +
        `${event.observedAreaKm2} km². The reference or the parser changed; fix that before scoring.`,
    )
  }

  const bbox = unionBBox(polygons.map(polygonBBox))
  return {
    event,
    polygons,
    index: new PolygonIndex(polygons),
    bbox,
    areaKm2,
    centre: { longitude: (bbox[0] + bbox[2]) / 2, latitude: (bbox[1] + bbox[3]) / 2 },
    failurePoints,
  }
}
