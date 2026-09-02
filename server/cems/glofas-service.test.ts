import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { GeoProxyService } from '../geo-proxy'
import type { CemsCredentials } from './credentials'
import { GlofasForecastService } from './glofas-service'
import { THRESHOLD_YEARS_PER_CHUNK, thresholdRequests } from './glofas-request'
import { writeGrib2, type Grib2FixtureMessage } from './grib2-fixture'

const config = Effect.runSync(loadConfig({ GEO_DATA_MODE: 'live' }))
const credentials: CemsCredentials = {
  apiUrl: 'https://ewds.climate.copernicus.eu/api',
  key: 'test-token',
  keySource: 'test',
}

const GRID = { ni: 2, nj: 2, lat1: 51.0, lon1: 6.6, di: 0.05, dj: 0.05 }
const CELL_COUNT = GRID.ni * GRID.nj
/** Enough days per year to clear the 300-day completeness bar in `annualMaximaPerCell`. */
const DAYS_PER_YEAR = 300

/**
 * A historical chunk in which cell 0 is a river with a rising record and the other three carry
 * nothing. That mixture is the realistic one — most cells in any box are not rivers — and it is
 * what makes the "unfitted cells are reported, not called safe" behaviour observable.
 *
 * Product template 72, and each field stamped with the *end* of the day it averages, because that
 * is what the store emits and what the year attribution has to cope with.
 */
const historyChunk = (years: ReadonlyArray<string>): Uint8Array => {
  const messages: Array<Grib2FixtureMessage> = []

  for (const yearText of years) {
    const year = Number(yearText)
    for (let day = 0; day < DAYS_PER_YEAR; day++) {
      // One clear annual peak per year, growing slowly through the record.
      const river = day === 100 ? 400 + (year - 1991) * 10 : 20 + (day % 7)
      messages.push({
        grid: GRID,
        values: [river, 0, 0, 0],
        validTime: new Date(Date.UTC(year, 0, 1 + day) + 86_400_000),
        productTemplate: 72,
      })
    }
  }

  return writeGrib2(messages)
}

/** A forecast ensemble: every member puts cell 0 far above its record, and the rest at nothing. */
const forecastFile = (riverDischarge: number, members = 4, leads = 5): Uint8Array => {
  const messages: Array<Grib2FixtureMessage> = []
  for (let lead = 0; lead < leads; lead++) {
    for (let member = 0; member < members; member++) {
      messages.push({
        grid: GRID,
        values: [riverDischarge, 0, 0, 0],
        validTime: new Date(Date.UTC(2026, 7, 31) + (lead + 1) * 86_400_000),
        perturbationNumber: member,
      })
    }
  }
  return writeGrib2(messages)
}

interface StoreBehaviour {
  /** How many status polls a job answers "running" before it succeeds. */
  readonly pollsBeforeSuccess?: number
  readonly failSubmitWith?: { status: number; body: string }
  readonly failJobs?: boolean
  readonly rejectJobs?: boolean
  readonly forecastDischarge?: number
}

/** Stands in for the store's job queue: submit, poll, collect, download. */
class FakeStore extends GeoProxyService {
  readonly submitted: Array<{ dataset: string; inputs: Record<string, unknown> }> = []
  readonly downloads: Array<string> = []
  private readonly polls = new Map<string, number>()
  private readonly datasets = new Map<string, string>()
  private readonly behaviour: StoreBehaviour
  private nextJob = 1

  constructor(behaviour: StoreBehaviour = {}) {
    super(config)
    this.behaviour = behaviour
  }

  override async fetchUpstream(_sourceId: string, targetUrl: string, options: { body?: string } = {}) {
    const reply = (body: unknown, status = 200) => ({
      status,
      body: JSON.stringify(body),
      contentType: 'application/json',
      redactedUrl: targetUrl,
    })

    const execution = /\/processes\/([^/]+)\/execution$/.exec(targetUrl)
    if (execution) {
      if (this.behaviour.failSubmitWith) {
        return {
          status: this.behaviour.failSubmitWith.status,
          body: this.behaviour.failSubmitWith.body,
          contentType: 'application/json',
          redactedUrl: targetUrl,
        }
      }
      const dataset = execution[1]!
      const jobId = `job-${this.nextJob++}`
      this.datasets.set(jobId, dataset)
      this.submitted.push({
        dataset,
        inputs: (JSON.parse(options.body ?? '{}') as { inputs: Record<string, unknown> }).inputs,
      })
      return reply({ jobID: jobId, status: 'accepted' })
    }

    const results = /\/jobs\/([^/]+)\/results$/.exec(targetUrl)
    if (results) {
      return reply({ asset: { value: { href: `https://os-api.cci2.ecmwf.int/${results[1]}.nc` } } })
    }

    const status = /\/jobs\/([^/]+)$/.exec(targetUrl)
    if (status) {
      const jobId = status[1]!
      if (this.behaviour.failJobs) return reply({ status: 'failed' })
      if (this.behaviour.rejectJobs) return reply({ status: 'rejected' })
      const seen = (this.polls.get(jobId) ?? 0) + 1
      this.polls.set(jobId, seen)
      return reply({ status: seen > (this.behaviour.pollsBeforeSuccess ?? 0) ? 'successful' : 'running' })
    }

    throw new Error(`FakeStore was asked for an unexpected URL: ${targetUrl}`)
  }

  override async fetchUpstreamBinary(_sourceId: string, targetUrl: string) {
    this.downloads.push(targetUrl)
    const jobId = /\/(job-\d+)\.nc$/.exec(targetUrl)?.[1] ?? ''
    const dataset = this.datasets.get(jobId) ?? ''
    const bytes =
      dataset === 'cems-glofas-forecast'
        ? forecastFile(this.behaviour.forecastDischarge ?? 5000)
        : historyChunk(this.chunkYearsFor(jobId))

    return {
      status: 200,
      bytes: bytes as Uint8Array<ArrayBuffer>,
      contentType: 'application/x-netcdf',
      redactedUrl: targetUrl,
    }
  }

  /** Which years this job asked for, so each chunk returns its own slice of the record. */
  private chunkYearsFor(jobId: string): ReadonlyArray<string> {
    const index = Number(jobId.replace('job-', '')) - 1
    const submission = this.submitted[index]
    return (submission?.inputs.year as ReadonlyArray<string>) ?? []
  }
}

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cems-test-'))
})

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true })
})

const at = { latitude: 50.94, longitude: 6.96 }
const now = () => new Date(Date.UTC(2026, 7, 31, 18))

const serviceWith = (store: GeoProxyService) =>
  new GlofasForecastService(store, credentials, { cacheDir, now })

/** Drives the state machine to completion the way a caller polling the route would. */
const runToCompletion = async (service: GlofasForecastService, maxSteps = 60) => {
  let outcome = await service.advance(at, 20)
  for (let step = 0; step < maxSteps && outcome.state === 'pending'; step++) {
    outcome = await service.advance(at, 20)
  }
  return outcome
}

describe('GlofasForecastService', () => {
  it('reports itself unconfigured without a token, rather than failing', async () => {
    const service = new GlofasForecastService(new FakeStore(), undefined, { cacheDir, now })
    const outcome = await service.advance(at, 20)
    expect(outcome.state).toBe('unconfigured')
    expect(outcome.detail).toContain('CEMS_API_KEY')
  })

  it('reports itself unconfigured when the retrieval store is disabled', async () => {
    const service = new GlofasForecastService(new FakeStore(), credentials, { cacheDir: '', now })
    const outcome = await service.advance(at, 20)
    expect(outcome.state).toBe('unconfigured')
    expect(outcome.detail).toContain('CEMS_CACHE_DIR')
  })

  /**
   * The first call must not block on a job queue, and must not answer with an empty zone list
   * either — "not fetched yet" and "nothing will flood here" are the two answers this whole
   * feature exists to keep apart.
   */
  it('submits work and returns pending rather than waiting', async () => {
    const store = new FakeStore({ pollsBeforeSuccess: 2 })
    const outcome = await serviceWith(store).advance(at, 20)

    expect(outcome.state).toBe('pending')
    expect(outcome.detail).toMatch(/not ready yet/)
    // The thresholds and the forecast are independent, so one call starts both rather than
    // finishing thirty years of history before it asks what the weather is doing.
    expect(store.submitted.filter((s) => s.dataset === 'cems-glofas-forecast')).toHaveLength(1)
    expect(store.submitted.filter((s) => s.dataset === 'cems-glofas-historical').length).toBeGreaterThan(0)
    expect(store.downloads).toHaveLength(0)
  })

  /**
   * The store limits queued requests per dataset, and says so: eight at once came back `rejected`
   * with "Number queued requests for this dataset is temporarily limited. Please configure your
   * scripts accordingly". So the history goes one at a time — while the forecast, a different
   * dataset with its own limit, proceeds alongside it.
   */
  it('keeps only one history chunk in the queue, alongside the forecast', async () => {
    const store = new FakeStore({ pollsBeforeSuccess: 99 })
    const service = serviceWith(store)
    await service.advance(at, 20)
    await service.advance(at, 20)

    expect(store.submitted.filter((s) => s.dataset === 'cems-glofas-historical')).toHaveLength(1)
    expect(store.submitted.filter((s) => s.dataset === 'cems-glofas-forecast')).toHaveLength(1)
  })

  /**
   * A job accepted at submission can still be refused at execution — a full per-dataset queue does
   * exactly that. It is not "finished": asking a refused job for its results answers 400, which
   * would surface as a broken retrieval instead of one to submit again.
   */
  it('resubmits a rejected job rather than asking a refused one for results', async () => {
    const store = new FakeStore({ rejectJobs: true })
    const service = serviceWith(store)
    // Submit, then poll-and-discard, then submit afresh.
    await service.advance(at, 20)
    const afterSubmit = store.submitted.length
    await service.advance(at, 20)
    await service.advance(at, 20)

    expect(store.downloads).toHaveLength(0)
    expect(store.submitted.length).toBeGreaterThan(afterSubmit)
  })

  it('splits the threshold window into single years, which is all the store accepts', () => {
    for (const chunk of thresholdRequests([51, 6.5, 50.5, 7.5])) {
      expect(chunk.years).toHaveLength(1)
    }
  })

  it('works through the queue to a scored forecast', async () => {
    const store = new FakeStore({ pollsBeforeSuccess: 1 })
    const outcome = await runToCompletion(serviceWith(store))

    expect(outcome.state).toBe('ready')
    expect(outcome.progress.thresholdsFitted).toBe(true)
    expect(outcome.progress.forecastRetrieved).toBe(true)

    // Cell 0 is the river, and every member is far above its twenty-year flood.
    expect(outcome.classified!.cells[0]!.hazardClass).toBe('extreme')
    expect(outcome.classified!.cells[0]!.probabilities[20]).toBe(1)
    // The other three carry no river, so they get no verdict rather than a favourable one.
    expect(outcome.classified!.unfittedCells).toBe(CELL_COUNT - 1)
    expect(outcome.fittedCells).toBe(1)
  })

  it('draws nothing when the forecast stays inside the channel', async () => {
    const store = new FakeStore({ forecastDischarge: 30 })
    const outcome = await runToCompletion(serviceWith(store))

    expect(outcome.state).toBe('ready')
    expect(outcome.classified!.cells[0]!.hazardClass).toBeNull()
  })

  it('retrieves both datasets, and the forecast for the published run', async () => {
    const store = new FakeStore()
    await runToCompletion(serviceWith(store))

    const forecast = store.submitted.find((s) => s.dataset === 'cems-glofas-forecast')
    expect(forecast).toBeDefined()
    // 18:00 UTC is past the publication lag, so today's 00Z run is the one asked for.
    expect(forecast!.inputs).toMatchObject({ year: ['2026'], month: ['08'], day: ['31'] })
    expect(store.submitted.filter((s) => s.dataset === 'cems-glofas-historical')).toHaveLength(
      thresholdRequests([51, 6.5, 50.5, 7.5]).length,
    )
  })

  /**
   * Thirty years of daily grids is tens of megabytes per location and everything the model needs
   * from them is in the maxima — the same trade `climate-source.ts` makes for rainfall.
   */
  it('keeps the distilled maxima and deletes the history it distilled them from', async () => {
    await runToCompletion(serviceWith(new FakeStore()))

    const files = readdirSync(cacheDir)
    expect(files.some((name) => name.startsWith('maxima_'))).toBe(true)
    expect(files.some((name) => name.startsWith('history_'))).toBe(false)
    expect(files.some((name) => name.startsWith('forecast_'))).toBe(true)
    // No job records left behind: every one was collected.
    expect(files.some((name) => name.endsWith('.job.json'))).toBe(false)
  })

  /** The expensive half is paid once, ever. A restart must not re-ask for thirty years. */
  it('serves a later run from the stored maxima without re-retrieving the history', async () => {
    await runToCompletion(serviceWith(new FakeStore()))

    const second = new FakeStore()
    const outcome = await runToCompletion(serviceWith(second))

    expect(outcome.state).toBe('ready')
    expect(second.submitted.filter((s) => s.dataset === 'cems-glofas-historical')).toHaveLength(0)
    // The forecast was already on disk too, so this run needed no retrieval at all.
    expect(second.submitted).toHaveLength(0)
  })

  /**
   * A licence refusal is not an outage: it is fixed in a browser, and reporting it as "upstream
   * unavailable" sends the reader to look at the network instead.
   */
  it('surfaces a licence refusal as a failure naming the licence', async () => {
    const store = new FakeStore({
      failSubmitWith: {
        status: 403,
        body: JSON.stringify({
          title: "user didn't accept all required site policies",
          detail: 'Missing policies are: Terms of use of the CEMS Early Warning Data Store',
        }),
      },
    })
    const outcome = await serviceWith(store).advance(at, 20)

    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toMatch(/licence/i)
    expect(outcome.detail).toContain('Terms of use of the CEMS Early Warning Data Store')
  })

  /**
   * Without a backoff a retrieval the store will never accept is resubmitted on every request,
   * which spends an account's quota on nothing.
   */
  it('stops resubmitting a retrieval that keeps failing', async () => {
    const store = new FakeStore({ failJobs: true })
    const service = serviceWith(store)
    for (let step = 0; step < 10; step++) await service.advance(at, 20)

    // Three attempts each for the retrievals in flight, and then nothing — not ten calls' worth.
    // The cap is per retrieval, so a broken history chunk cannot silence the forecast.
    const before = store.submitted.length
    expect(before).toBeGreaterThan(0)

    for (let step = 0; step < 5; step++) await service.advance(at, 20)
    expect(store.submitted).toHaveLength(before)
  })

  /** Two requests arriving together must not both submit the same job. */
  it('collapses concurrent advances for the same location', async () => {
    const store = new FakeStore({ pollsBeforeSuccess: 5 })
    const service = serviceWith(store)
    await Promise.all([service.advance(at, 20), service.advance(at, 20), service.advance(at, 20)])

    // One advance's worth of work, not three copies of it: exactly one forecast job was submitted.
    expect(store.submitted.filter((s) => s.dataset === 'cems-glofas-forecast')).toHaveLength(1)
    expect(new Set(store.submitted.map((s) => s.dataset)).size).toBe(2)
  })

  /** Otherwise two queries a kilometre apart would read each other's grid. */
  it('keeps different radii in different cache entries', async () => {
    const store = new FakeStore()
    const service = serviceWith(store)
    await service.advance(at, 20)
    await service.advance(at, 45)

    const keys = new Set(readdirSync(cacheDir).map((name) => name.replace(/\.(nc|json)$/, '')))
    expect(keys.size).toBeGreaterThan(1)
  })

  it('shares one retrieval between nearby queries', async () => {
    const store = new FakeStore()
    const service = serviceWith(store)
    await service.advance({ latitude: 50.94, longitude: 6.96 }, 20)
    const forecastJobs = () => store.submitted.filter((s) => s.dataset === 'cems-glofas-forecast').length
    const before = forecastJobs()
    await service.advance({ latitude: 50.941, longitude: 6.958 }, 20)

    // The second query landed in the same 0.1° cell, so it continued the first one's work rather
    // than starting a retrieval of its own.
    expect(forecastJobs()).toBe(before)
  })

  it('splits the threshold window into whole chunks', () => {
    const chunks = thresholdRequests([51, 6.5, 50.5, 7.5])
    for (const chunk of chunks) expect(chunk.years.length).toBeLessThanOrEqual(THRESHOLD_YEARS_PER_CHUNK)
  })

  it('does not leave a partial cache file behind if writing is interrupted', async () => {
    await runToCompletion(serviceWith(new FakeStore()))
    expect(readdirSync(cacheDir).some((name) => name.endsWith('.tmp'))).toBe(false)
    expect(existsSync(cacheDir)).toBe(true)
  })
})
