/**
 * The European forecast, assembled from a store that answers in its own time.
 *
 * A retrieval is a queued job, so nothing here waits for one. Each call moves the work forward by
 * exactly one step and reports where it got to, and the caller comes back later. That is a
 * deliberate choice over a background worker: the sequence is then driven by requests, is the same
 * every run, and can be tested by calling `advance` four times instead of by waiting on a timer.
 * `tools/warm-cems.ts` is the same loop with nobody waiting at the other end.
 *
 * Two things are retrieved, and the slow one is only retrieved once ever:
 *
 *  - **Thresholds.** Thirty years of daily reanalysis at the same cells, distilled to annual
 *    maxima. Six jobs, slow, and then kept on disk forever — the 1991–2020 flood frequency of a
 *    river does not change because somebody reloaded the page. This is the same bargain the ERA5
 *    rainfall climatology strikes in `climate-source.ts`, for the same reason.
 *  - **The forecast.** One job per run per location, and a new run appears daily.
 *
 * The intermediate history files are deleted once distilled; the maxima are the asset worth
 * keeping, exactly as `climate-source.ts` keeps its series rather than the fitted level, so that a
 * change to the extreme-value fit is picked up on the next run instead of frozen into a cache.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LonLat } from '../../src/domain/geo'
import type { GeoProxyService } from '../geo-proxy'
import type { CemsCredentials } from './credentials'
import {
  annualMaximaPerCell,
  classifyForecast,
  fieldGridFromMessages,
  returnLevelsPerCell,
  yearsForSlices,
  type ClassifiedForecast,
  type FieldGrid,
} from './glofas-grid'
import {
  forecastArea,
  forecastRequest,
  GLOFAS_FORECAST_DATASET,
  GLOFAS_HISTORICAL_DATASET,
  latestForecastRun,
  locationKey,
  thresholdRequests,
  type ForecastRun,
  type StoreArea,
} from './glofas-request'
import { parseGrib2 } from './grib2'
import { CemsRequestError, CemsStoreClient, type JobStatus } from './store-client'

/**
 * Radius buckets, in km. The retrieved box has to be a function of the cache key alone, or two
 * queries a kilometre apart would read each other's grid and misplace every cell in it.
 */
const RADIUS_BUCKET_KM = 5
const MAX_RADIUS_KM = 50

/** Forecast runs older than this are pruned; a superseded run is not worth the disk. */
const KEEP_RUNS_MS = 3 * 86_400_000

/**
 * How many times a chunk may fail before it is left alone for a while.
 *
 * Without this, a retrieval the store will never accept — a bad year, a dataset withdrawn — is
 * resubmitted on every single request, which is both useless and the fastest way to spend an
 * account's quota on nothing.
 */
const MAX_JOB_FAILURES = 3
const FAILURE_BACKOFF_MS = 30 * 60_000

/**
 * How many historical chunks may sit in the store's queue at once.
 *
 * One, because the store says so. Eight was tried on 2026-08-31 to shorten the thirty-retrieval
 * warm-up, and every one of the eight came back `rejected` with:
 *
 *     Number queued requests for this dataset is temporarily limited.
 *     Please configure your scripts accordingly
 *
 * The limit is per dataset, so the forecast retrieval still runs alongside the history — the two
 * are different datasets and do not compete. Within the history, this is a queue shared with every
 * other Copernicus user, and "configure your scripts accordingly" is not a suggestion.
 */
const MAX_QUEUED_CHUNKS = 1

export type ForecastState = 'ready' | 'pending' | 'unconfigured' | 'failed'

export interface ForecastProgress {
  readonly thresholdChunksReady: number
  readonly thresholdChunksTotal: number
  readonly thresholdsFitted: boolean
  readonly forecastRetrieved: boolean
}

export interface ForecastOutcome {
  readonly state: ForecastState
  readonly detail: string
  readonly progress: ForecastProgress
  readonly run?: ForecastRun
  readonly area?: StoreArea
  readonly grid?: FieldGrid
  readonly classified?: ClassifiedForecast
  /** Cells with a usable flood frequency curve, out of the whole box. */
  readonly fittedCells?: number
}

interface JobRecord {
  readonly jobId: string
  readonly dataset: string
  readonly submittedAt: number
}

interface FailureRecord {
  readonly failures: number
  readonly lastFailedAt: number
  readonly message: string
}

interface StoredMaxima {
  readonly area: StoreArea
  readonly width: number
  readonly height: number
  readonly latitudes: ReadonlyArray<number>
  readonly longitudes: ReadonlyArray<number>
  /** Annual maxima per cell, m³/s. Outer index is the cell, in row-major order. */
  readonly maximaPerCell: ReadonlyArray<ReadonlyArray<number>>
  readonly retrievedAt: string
}

export interface GlofasServiceOptions {
  readonly cacheDir: string
  readonly now?: () => Date
}

/** The centre of the cache cell, so the retrieved box depends on the key rather than the query. */
const keyCentre = (at: LonLat): LonLat => ({
  latitude: Number(at.latitude.toFixed(1)),
  longitude: Number(at.longitude.toFixed(1)),
})

const bucketRadius = (radiusKm: number): number => {
  const finite = Number.isFinite(radiusKm) && radiusKm > 0 ? radiusKm : 20
  return Math.min(MAX_RADIUS_KM, Math.ceil(finite / RADIUS_BUCKET_KM) * RADIUS_BUCKET_KM)
}

export const cacheKeyFor = (at: LonLat, radiusKm: number): string =>
  `${locationKey(keyCentre(at))}_r${bucketRadius(radiusKm)}`

export class GlofasForecastService {
  private readonly cacheDir: string
  private readonly now: () => Date
  /** One advance at a time per location, so two requests cannot both submit the same job. */
  private readonly inFlight = new Map<string, Promise<ForecastOutcome>>()
  private readonly failures = new Map<string, FailureRecord>()

  private readonly proxy: GeoProxyService
  private readonly credentials: CemsCredentials | undefined

  constructor(
    proxy: GeoProxyService,
    credentials: CemsCredentials | undefined,
    options: GlofasServiceOptions,
  ) {
    this.proxy = proxy
    this.credentials = credentials
    this.cacheDir = options.cacheDir
    this.now = options.now ?? (() => new Date())
  }

  get configured(): boolean {
    return this.credentials !== undefined && this.cacheDir !== ''
  }

  /**
   * Moves the retrieval for one location forward by one step, and says where it got to.
   *
   * Never throws for an upstream problem: a store outage is a coverage statement, not a crash, and
   * the caller has an honest empty answer to give either way.
   */
  async advance(at: LonLat, radiusKm: number): Promise<ForecastOutcome> {
    const key = cacheKeyFor(at, radiusKm)
    const running = this.inFlight.get(key)
    if (running !== undefined) return running

    const work = this.advanceUnguarded(at, radiusKm, key).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, work)
    return work
  }

  private path(name: string): string {
    return join(this.cacheDir, name)
  }

  private readJson<T>(name: string): T | undefined {
    try {
      return JSON.parse(readFileSync(this.path(name), 'utf8')) as T
    } catch {
      return undefined
    }
  }

  /** Renamed into place, never written in place: a half-written cache is a wrong answer. */
  private writeAtomic(name: string, contents: string | Uint8Array): void {
    mkdirSync(this.cacheDir, { recursive: true })
    const target = this.path(name)
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, contents)
    renameSync(temporary, target)
  }

  private remove(name: string): void {
    try {
      rmSync(this.path(name), { force: true })
    } catch {
      // A cache that will not delete costs disk, not correctness.
    }
  }

  private noteFailure(key: string, message: string): void {
    const current = this.failures.get(key)
    this.failures.set(key, {
      failures: (current?.failures ?? 0) + 1,
      lastFailedAt: this.now().getTime(),
      message,
    })
  }

  private backedOff(key: string): FailureRecord | undefined {
    const record = this.failures.get(key)
    if (record === undefined || record.failures < MAX_JOB_FAILURES) return undefined
    if (this.now().getTime() - record.lastFailedAt > FAILURE_BACKOFF_MS) {
      this.failures.delete(key)
      return undefined
    }
    return record
  }

  /**
   * One step of one retrieval: submit it, or check on it, or collect it.
   *
   * Returns the file's bytes only when it is actually on disk; `undefined` means "not yet", which
   * is the normal answer for the first several calls.
   */
  private async advanceRetrieval(
    client: CemsStoreClient,
    fileName: string,
    jobKey: string,
    dataset: string,
    inputs: Record<string, unknown>,
  ): Promise<{ readonly bytes?: Uint8Array; readonly note?: string }> {
    if (existsSync(this.path(fileName))) {
      return { bytes: readFileSync(this.path(fileName)) }
    }

    const blocked = this.backedOff(jobKey)
    if (blocked !== undefined) return { note: blocked.message }

    const jobFile = `${jobKey}.job.json`
    const job = this.readJson<JobRecord>(jobFile)

    try {
      if (job === undefined) {
        const submitted = await client.submit(dataset, inputs)
        this.writeAtomic(
          jobFile,
          JSON.stringify({ jobId: submitted.jobId, dataset, submittedAt: this.now().getTime() }),
        )
        return { note: 'submitted' }
      }

      const status: JobStatus = await client.status(job.jobId)
      if (status === 'accepted' || status === 'running') return { note: status }

      if (status === 'failed' || status === 'dismissed' || status === 'rejected') {
        // Forget the job so the next call submits a fresh one, but count it: a retrieval the store
        // will never accept must not be resubmitted on every request forever.
        this.remove(jobFile)
        this.noteFailure(jobKey, `the store reported the retrieval ${status}`)
        return { note: status }
      }
      if (status !== 'successful') {
        // An unrecognised state is not a finished one. Asking for a running job's results answers
        // 400, which would be reported as a broken retrieval rather than as one still going.
        return { note: `the store reported an unrecognised job state "${status}"` }
      }

      const result = await client.result(job.jobId)
      const bytes = await client.download(result.href)
      this.writeAtomic(fileName, bytes)
      this.remove(jobFile)
      this.failures.delete(jobKey)
      return { bytes }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      // A licence refusal is not transient and not worth retrying against; it is reported upward
      // so the reader is sent to a browser rather than to the network logs.
      if (err instanceof CemsRequestError && (err.kind === 'licence' || err.kind === 'auth')) {
        this.noteFailure(jobKey, message)
        throw err
      }
      this.noteFailure(jobKey, message)
      return { note: message }
    }
  }

  private async advanceUnguarded(at: LonLat, radiusKm: number, key: string): Promise<ForecastOutcome> {
    const chunks = thresholdRequests(forecastArea(keyCentre(at), bucketRadius(radiusKm)))
    const emptyProgress: ForecastProgress = {
      thresholdChunksReady: 0,
      thresholdChunksTotal: chunks.length,
      thresholdsFitted: false,
      forecastRetrieved: false,
    }

    if (this.credentials === undefined) {
      return {
        state: 'unconfigured',
        detail:
          'No Copernicus data-store token is configured, so the European flood forecast was not ' +
          'retrieved. Set CEMS_API_KEY (or keep a `key:` line in .env) and restart.',
        progress: emptyProgress,
      }
    }
    if (this.cacheDir === '') {
      return {
        state: 'unconfigured',
        detail:
          'CEMS_CACHE_DIR is empty, which disables the retrieval store. A GloFAS forecast takes ' +
          'minutes to retrieve and thirty years of history to interpret; without somewhere to keep ' +
          'them, no request would ever be answered from what a previous one paid for.',
        progress: emptyProgress,
      }
    }

    const area = forecastArea(keyCentre(at), bucketRadius(radiusKm))
    const client = new CemsStoreClient(this.proxy, this.credentials)
    const run = latestForecastRun(this.now())

    try {
      const thresholdOutcome = await this.ensureThresholds(client, key, area, chunks)
      const forecastOutcome = await this.advanceRetrieval(
        client,
        `forecast_${key}_${run.year}${run.month}${run.day}.grib`,
        `forecast_${key}_${run.year}${run.month}${run.day}`,
        GLOFAS_FORECAST_DATASET,
        forecastRequest(run, area),
      )

      const progress: ForecastProgress = {
        thresholdChunksReady: thresholdOutcome.chunksReady,
        thresholdChunksTotal: chunks.length,
        thresholdsFitted: thresholdOutcome.stored !== undefined,
        forecastRetrieved: forecastOutcome.bytes !== undefined,
      }

      if (thresholdOutcome.stored === undefined || forecastOutcome.bytes === undefined) {
        return {
          state: 'pending',
          detail: this.describePending(progress, thresholdOutcome.note ?? forecastOutcome.note),
          progress,
          run,
          area,
        }
      }

      this.pruneOldRuns(key, run)

      const grid = fieldGridFromMessages(parseGrib2(forecastOutcome.bytes))
      const stored = thresholdOutcome.stored
      if (grid.cellCount !== stored.width * stored.height) {
        // The two retrievals must describe the same ground or every comparison is between a cell
        // and some other cell's history. Refusing is the only honest option.
        return {
          state: 'failed',
          detail:
            `The forecast grid (${grid.width}×${grid.height}) does not match the history the ` +
            `thresholds were fitted on (${stored.width}×${stored.height}), so no cell could be ` +
            `compared with its own record. Clear ${this.cacheDir} to retrieve both again.`,
          progress,
          run,
          area,
        }
      }

      const thresholds = returnLevelsPerCell(stored.maximaPerCell)
      const classified = classifyForecast(grid, thresholds)

      return {
        state: 'ready',
        detail: 'GloFAS ensemble forecast scored against each cell’s own 1991–2020 flood frequency.',
        progress,
        run,
        area,
        grid,
        classified,
        fittedCells: thresholds.filter((cell) => cell.levels !== undefined).length,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { state: 'failed', detail: message, progress: emptyProgress, run, area }
    }
  }

  /**
   * The thresholds, retrieving and distilling them if this is the first time this location has
   * been asked about. Returns as soon as one chunk is outstanding — the rest is next call's work.
   */
  private async ensureThresholds(
    client: CemsStoreClient,
    key: string,
    area: StoreArea,
    chunks: ReturnType<typeof thresholdRequests>,
  ): Promise<{ readonly stored?: StoredMaxima; readonly chunksReady: number; readonly note?: string }> {
    const maximaFile = `maxima_${key}.json`
    const stored = this.readJson<StoredMaxima>(maximaFile)
    if (stored?.maximaPerCell !== undefined) {
      return { stored, chunksReady: chunks.length }
    }

    const grids: Array<{ grid: FieldGrid; years: ReadonlyArray<number> }> = []
    let outstanding = 0
    let note: string | undefined

    /**
     * Every chunk is advanced on every call, up to a cap on how many may be queued at once.
     *
     * One at a time was the original design, on the reasoning that the store queues per account so
     * parallelism buys nothing. That was wrong once the store's size limit forced the window into
     * thirty one-year chunks: walked serially, each needing its own submit-poll-collect round
     * trip, warming a location took the better part of an hour of mostly waiting. The cap is what
     * keeps this from turning into thirty simultaneous submissions.
     */
    for (const [index, chunk] of chunks.entries()) {
      const fileName = `history_${key}_${index}.grib`
      const jobKey = `history_${key}_${index}`

      if (!existsSync(this.path(fileName)) && outstanding >= MAX_QUEUED_CHUNKS) {
        outstanding++
        continue
      }

      const outcome = await this.advanceRetrieval(
        client,
        fileName,
        jobKey,
        GLOFAS_HISTORICAL_DATASET,
        chunk.inputs,
      )
      if (outcome.bytes === undefined) {
        outstanding++
        note ??= outcome.note
        continue
      }

      const grid = fieldGridFromMessages(parseGrib2(outcome.bytes))
      const years = yearsForSlices(grid)
      if (years === undefined) {
        throw new Error(
          `The historical retrieval for ${chunk.years.join(', ')} carries no readable time axis, ` +
            'so its daily values could not be grouped into years.',
        )
      }
      grids.push({ grid, years })
    }

    // The maxima can only be fitted once every year of the window is in; a partial series would
    // fit a return level on whichever years happened to arrive first.
    if (grids.length < chunks.length) return { chunksReady: grids.length, note }

    const maximaPerCell = annualMaximaPerCell(grids)
    const first = grids[0]!.grid
    const record: StoredMaxima = {
      area,
      width: first.width,
      height: first.height,
      latitudes: first.latitudes,
      longitudes: first.longitudes,
      maximaPerCell,
      retrievedAt: this.now().toISOString(),
    }
    this.writeAtomic(maximaFile, JSON.stringify(record))

    // The chunks were the means, not the asset: thirty years of daily grids is tens of megabytes
    // per location, and everything the model needs from them is now in the maxima.
    for (let index = 0; index < chunks.length; index++) this.remove(`history_${key}_${index}.grib`)

    return { stored: record, chunksReady: chunks.length }
  }

  private describePending(progress: ForecastProgress, note: string | undefined): string {
    const parts: Array<string> = []
    if (!progress.thresholdsFitted) {
      parts.push(
        `retrieving the 1991–2020 river-discharge history this location's flood thresholds are ` +
          `fitted from (${progress.thresholdChunksReady} of ${progress.thresholdChunksTotal} parts ` +
          `collected)`,
      )
    }
    if (!progress.forecastRetrieved) parts.push('retrieving the current GloFAS forecast run')

    return (
      `The European flood forecast is not ready yet: ${parts.join(', and ')}. Copernicus runs ` +
      `retrievals as queued jobs, so this takes minutes on first use at a location and is then ` +
      `served from disk. Ask again shortly.` + (note !== undefined ? ` Last step: ${note}.` : '')
    )
  }

  /** Yesterday's run is superseded the moment today's lands; keeping it is keeping stale weather. */
  private pruneOldRuns(key: string, run: ForecastRun): void {
    try {
      for (const name of readdirSync(this.cacheDir)) {
        const match = new RegExp(`^forecast_${key}_(\\d{4})(\\d{2})(\\d{2})\\.grib$`).exec(name)
        if (!match) continue
        const basetime = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
        if (run.basetime - basetime > KEEP_RUNS_MS) this.remove(name)
      }
    } catch {
      // Pruning is housekeeping; failing at it must not fail a forecast.
    }
  }
}
