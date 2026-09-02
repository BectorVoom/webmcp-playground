/**
 * Fills the on-disk DEM store for the hindcast sites, using `curl` rather than
 * `fetch`.
 *
 * This exists for one specific, verified reason. `cyberjapandata.gsi.go.jp` is
 * fronted by CloudFront and publishes AAAA records. On a host with no working
 * IPv6 route, Bun's `fetch` picks the AAAA address and blocks until the request
 * times out — it has no Happy Eyeballs fallback to the A record — so every GSI
 * tile fails while `curl` fetches the same URL in 120 ms. The global terrarium
 * host is IPv4-only, which is why the model has never met this.
 *
 * So the *server* keeps using `fetch` (correct on any host with working IPv6, or
 * with IPv4-only DNS), and this warms the same store it reads from. After a run
 * of this, a scored run touches no GSI endpoint at all. Nothing here is a
 * workaround the production path depends on.
 *
 *   bun tools/hindcast/warm-dem.ts gsi10 gsi5
 */
import { existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { EVENTS } from './events'
import { loadObserved } from './observed'
import { DEFAULT_DEM_CACHE_DIR, DEM_SOURCES, type DemSource } from '../../server/flood-inputs'
import { tileRangeForCircle } from '../../src/lib/hydrology/terrain'

/**
 * Mirrors `chooseDemZoom`'s budget loop. Imported would drag the whole server
 * config in; the rule is four lines and is asserted against the route's own
 * reported `demZoom` when the comparison runs.
 */
const MAX_GRID_CELLS = 64 * 256 * 256
const resolveZoom = (
  centre: { longitude: number; latitude: number },
  radiusKm: number,
  startZoom: number,
) => {
  let zoom = startZoom
  let range = tileRangeForCircle(centre, radiusKm, zoom)
  while (zoom > 8 && range.count * 256 * 256 > MAX_GRID_CELLS) {
    zoom -= 1
    range = tileRangeForCircle(centre, radiusKm, zoom)
  }
  return { zoom, range }
}

const main = async (): Promise<void> => {
  const sources = (process.argv.slice(2).length ? process.argv.slice(2) : ['gsi10']) as DemSource[]
  const sites = await Promise.all(EVENTS.map(loadObserved))

  for (const source of sources) {
    const spec = DEM_SOURCES[source]
    if (!spec) throw new Error(`unknown DEM source: ${source}`)

    for (const site of sites) {
      const { zoom, range } = resolveZoom(site.centre, site.event.radiusKm, spec.startZoom)
      let fetched = 0
      let had = 0
      let missing = 0

      for (let x = range.minX; x <= range.maxX; x++) {
        for (let y = range.minY; y <= range.maxY; y++) {
          const path = join(DEFAULT_DEM_CACHE_DIR, source, String(zoom), String(x), `${y}.png`)
          if (existsSync(path)) {
            had++
            continue
          }
          mkdirSync(dirname(path), { recursive: true })
          const result = spawnSync(
            'curl',
            ['-4', '-sS', '--fail', '-m', '30', '-o', path, spec.url(zoom, x, y)],
            { encoding: 'utf8' },
          )
          if (result.status === 0) fetched++
          else missing++
        }
      }
      console.log(
        `${source.padEnd(6)} ${site.event.id.padEnd(7)} z${zoom} ` +
          `${range.count} tiles: ${had} stored, ${fetched} fetched, ${missing} missing`,
      )
      if (missing > 0) {
        console.log(
          `  ${missing} tile(s) the publisher does not serve here — a run on ${source} at ` +
            `${site.event.id} will fail rather than quietly model a hole in the ground.`,
        )
      }
    }
  }
}

if (import.meta.main) {
  await main()
}
