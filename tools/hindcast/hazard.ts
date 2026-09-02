/**
 * The official hazard-map envelope, as a second reference to score against.
 *
 * Every figure this harness has ever produced scores the model against **one
 * event's surveyed extent** — the water that actually stood on the ground on one
 * day, which is the water one particular levee failure happened to put there.
 * The model does not predict that. It maps the ground a design storm can reach,
 * which is an *envelope*, and an envelope scored against a single realisation is
 * charged for every correct cell the event did not happen to occupy.
 *
 * So this loads what Japan's own screening product says, at the same 100 m
 * lattice points: MLIT's 洪水浸水想定区域 (flood inundation assumption zone) at
 * the L2 "maximum assumed scale" storm, served as raster tiles by GSI's
 * disaster-information portal. It is the closest thing to a like-for-like
 * reference this model has — a national, official, envelope-shaped answer to the
 * question the model is actually asking.
 *
 * It is a *reference*, not truth: it is itself modelled, it is drawn per river
 * system by the managing authority, and it is designated only where a river has
 * been designated. Those limits are reported rather than hidden — see
 * `coverage` on the returned mask.
 *
 * Source: https://disaportal.gsi.go.jp/ (ハザードマップポータルサイト),
 * tileset `01_flood_l2_shinsuishin_data`. Terms permit use with attribution.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PNG } from 'pngjs'
import type { LatticePoint } from './score'

export const HAZARD_CACHE_DIR = join('.cache', 'hindcast', 'hazard')

/**
 * Zoom of the raster read. 15.4 m per pixel at these latitudes — six times finer
 * than the 100 m scoring lattice, so any generalisation the portal does at this
 * zoom is well below the resolution anything is scored at, while a 20 km circle
 * still costs ~150 tiles rather than ~600 at z14.
 */
export const HAZARD_ZOOM = 13

const TILE_SIZE = 256

/**
 * The portal's published depth ramp. Matching is exact rather than nearest:
 * these are flat-filled PNG palettes, not interpolated imagery, and a nearest
 * match would silently absorb a legend change into the scores.
 */
export interface HazardBand {
  readonly rgb: readonly [number, number, number]
  readonly minM: number
  readonly maxM: number
  readonly label: string
}

export const HAZARD_BANDS: ReadonlyArray<HazardBand> = [
  { rgb: [247, 245, 169], minM: 0, maxM: 0.5, label: '< 0.5 m' },
  { rgb: [255, 216, 192], minM: 0.5, maxM: 3, label: '0.5-3 m' },
  { rgb: [255, 183, 183], minM: 3, maxM: 5, label: '3-5 m' },
  { rgb: [255, 145, 145], minM: 5, maxM: 10, label: '5-10 m' },
  { rgb: [242, 133, 201], minM: 10, maxM: 20, label: '10-20 m' },
  { rgb: [220, 122, 220], minM: 20, maxM: Infinity, label: '>= 20 m' },
]

const bandKey = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b
const BAND_BY_KEY = new Map<number, number>(
  HAZARD_BANDS.map((band, i) => [bandKey(...band.rgb), i + 1]),
)

const tileUrl = (z: number, x: number, y: number): string =>
  `https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/${z}/${x}/${y}.png`

const lon2tile = (lon: number, z: number): number => Math.floor(((lon + 180) / 360) * 2 ** z)
const lat2tile = (lat: number, z: number): number => {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
}
/** Fractional pixel position within the whole zoom level, for sub-tile indexing. */
const lon2px = (lon: number, z: number): number => ((lon + 180) / 360) * 2 ** z * TILE_SIZE
const lat2px = (lat: number, z: number): number => {
  const rad = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z * TILE_SIZE
}

/**
 * A tile the portal answers 404 for carries no designated zone — the ground is
 * outside every river's assumption area. That is a real answer ("not
 * designated"), not a failure, and it is stored as such so a rerun does not ask
 * again. It is *not* the same as "known dry", which is why `coverage` reports
 * how much of the window it accounts for.
 */
const NOT_DESIGNATED = new Uint8Array(0)

const fetchTile = async (z: number, x: number, y: number): Promise<Uint8Array> => {
  const path = join(HAZARD_CACHE_DIR, String(z), String(x), `${y}.png`)
  const missPath = `${path}.404`
  if (existsSync(missPath)) return NOT_DESIGNATED
  if (existsSync(path)) return new Uint8Array(await readFile(path))

  await mkdir(dirname(path), { recursive: true })
  const res = await fetch(tileUrl(z, x, y), {
    headers: { 'User-Agent': 'webmcp-playground/0.1.0 (safety-support)', Accept: 'image/png' },
  })
  if (res.status === 404) {
    await writeFile(missPath, '')
    return NOT_DESIGNATED
  }
  if (!res.ok) throw new Error(`hazard tile ${z}/${x}/${y} answered ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  await writeFile(path, bytes)
  return bytes
}

/** Bounded concurrency: the portal is a free public service, not a CDN to hammer. */
const mapWithLimit = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<R>> => {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i]!)
      }
    }),
  )
  return out
}

export interface HazardMask {
  /** Band index per lattice point: 0 outside the envelope, 1-6 into HAZARD_BANDS. */
  readonly bandAt: Uint8Array
  /** 1 where the point falls inside the designated envelope at any depth. */
  readonly wet: Uint8Array
  /**
   * 1 where the point's tile carries a designation at all, so `wet === 0` there
   * really means "mapped, and outside the zone".
   *
   * Where this is 0 the portal served no tile: no river's assumption area
   * reaches that ground. That is **not mapped**, not *known outside* — the same
   * distinction this harness draws for the surveyed extents, and for the same
   * reason. Scoring a model wrong on ground nobody assessed measures the
   * coverage of the reference, not the quality of the model.
   *
   * Tile-level is the finest granularity available: within a served tile the
   * zone boundary is drawn, so transparent there is a real "outside", but a tile
   * that does not exist says nothing about anywhere inside it.
   */
  readonly designated: Uint8Array
  readonly coverage: {
    readonly tilesRead: number
    /** Tiles the portal has no designated zone for, i.e. answered 404. */
    readonly tilesNotDesignated: number
    readonly pointsInEnvelope: number
    readonly pointsNotDesignated: number
    readonly pointsTotal: number
  }
}

/**
 * Reads the envelope at each lattice point. Only tiles that actually contain a
 * point are fetched, which for a circle clipped out of a padded rectangle is
 * about three-quarters of the bounding box.
 */
export const loadHazardMask = async (
  points: ReadonlyArray<LatticePoint>,
  zoom: number = HAZARD_ZOOM,
): Promise<HazardMask> => {
  const byTile = new Map<string, Array<number>>()
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!
    const key = `${lon2tile(point.longitude, zoom)}/${lat2tile(point.latitude, zoom)}`
    const bucket = byTile.get(key)
    if (bucket) bucket.push(i)
    else byTile.set(key, [i])
  }

  const bandAt = new Uint8Array(points.length)
  const designated = new Uint8Array(points.length)
  const tiles = [...byTile.entries()]
  let notDesignated = 0

  await mapWithLimit(tiles, 8, async ([key, indices]) => {
    const [x, y] = key.split('/').map(Number) as [number, number]
    const bytes = await fetchTile(zoom, x, y)
    if (bytes.length === 0) {
      notDesignated++
      return
    }
    for (const i of indices) designated[i] = 1
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    for (const i of indices) {
      const point = points[i]!
      const px = Math.min(TILE_SIZE - 1, Math.floor(lon2px(point.longitude, zoom)) - x * TILE_SIZE)
      const py = Math.min(TILE_SIZE - 1, Math.floor(lat2px(point.latitude, zoom)) - y * TILE_SIZE)
      if (px < 0 || py < 0) continue
      const o = (py * png.width + px) * 4
      if (png.data[o + 3]! === 0) continue
      bandAt[i] = BAND_BY_KEY.get(bandKey(png.data[o]!, png.data[o + 1]!, png.data[o + 2]!)) ?? 0
    }
  })

  const wet = Uint8Array.from(bandAt, (band) => (band > 0 ? 1 : 0))
  let inEnvelope = 0
  for (const flag of wet) inEnvelope += flag
  let unmapped = 0
  for (const flag of designated) if (flag === 0) unmapped++
  return {
    bandAt,
    wet,
    designated,
    coverage: {
      tilesRead: tiles.length,
      tilesNotDesignated: notDesignated,
      pointsInEnvelope: inEnvelope,
      pointsNotDesignated: unmapped,
      pointsTotal: points.length,
    },
  }
}
