/**
 * Warms the Copernicus retrieval store for a location, so the first real request is fast.
 *
 * The European forecast is assembled from queued jobs: thirty years of river-discharge history to
 * fit a location's flood thresholds from, and then the current forecast run. That is minutes on
 * first use at a place, and this is the loop that pays it with nobody waiting at the other end.
 * Afterwards the site answers from disk, and only the daily forecast run is ever re-retrieved.
 *
 *   bun tools/warm-cems.ts 50.94 6.96
 *   bun tools/warm-cems.ts 50.94 6.96 --radius 20
 *
 * It is the same `advance` the route calls, in a loop — deliberately, so what gets warmed is
 * exactly what gets served, rather than a second code path that can drift from it.
 */
import { Effect } from 'effect'
import { loadConfig } from '../server/config'
import { GeoProxyService } from '../server/geo-proxy'
import { describeCemsConfig, resolveCemsCredentials } from '../server/cems/credentials'
import { GlofasForecastService } from '../server/cems/glofas-service'

/** The store queues per account; polling faster than this only adds requests, not speed. */
const POLL_INTERVAL_MS = 20_000
/**
 * A cold location is thirty one-year history retrievals plus the forecast, and the store will only
 * queue one history request at a time. A single year took about ten minutes when this was
 * measured, so a cold location is a matter of hours rather than minutes — run it and go away.
 *
 * Nothing is lost by stopping early: every collected year is already on disk, and the next run
 * picks up from there rather than starting again.
 */
const MAX_WAIT_MS = 8 * 60 * 60_000

const usage = (): never => {
  console.error('usage: bun tools/warm-cems.ts <latitude> <longitude> [--radius <km>]')
  process.exit(1)
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const latitude = Number(args[0])
  const longitude = Number(args[1])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) usage()

  const radiusIndex = args.indexOf('--radius')
  const radiusKm = radiusIndex === -1 ? 20 : Number(args[radiusIndex + 1])
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) usage()

  const config = Effect.runSync(loadConfig())
  const credentials = resolveCemsCredentials()
  const warning = describeCemsConfig(credentials)
  if (warning !== null) console.warn(`[config] ${warning}`)
  if (credentials === undefined) process.exit(1)

  const service = new GlofasForecastService(new GeoProxyService(config), credentials, {
    cacheDir: config.cemsCacheDir,
  })

  console.log(
    `Warming ${latitude}, ${longitude} at ${radiusKm} km into ${config.cemsCacheDir}. ` +
      `Copernicus runs retrievals as queued jobs, so this is minutes rather than seconds.`,
  )

  const startedAt = Date.now()
  let lastDetail = ''

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const outcome = await service.advance({ latitude, longitude }, radiusKm)

    // Only when it changes: a status line repeated every twenty seconds for an hour is noise.
    if (outcome.detail !== lastDetail) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      console.log(`[${elapsed}s] ${outcome.state}: ${outcome.detail}`)
      lastDetail = outcome.detail
    }

    if (outcome.state === 'ready') {
      const drawn = outcome.classified?.cells.filter((cell) => cell.hazardClass !== null).length ?? 0
      console.log(
        `Ready. ${outcome.fittedCells} of ${outcome.classified?.cells.length} cells have a fitted ` +
          `flood frequency curve; ${drawn} are forecast above their two-year flood.`,
      )
      return
    }
    if (outcome.state !== 'pending') {
      console.error(`Stopped: ${outcome.detail}`)
      process.exit(1)
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  console.error(
    `Gave up after ${Math.round(MAX_WAIT_MS / 60_000)} minutes. The jobs are still queued at ` +
      `Copernicus and nothing is lost — run this again and it will pick up where it left off.`,
  )
  process.exit(1)
}

await main()
