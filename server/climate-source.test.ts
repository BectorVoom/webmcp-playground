import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  annualMaxima,
  era5ArchiveUrl,
  loadRainfallClimatology,
  readStoredSeries,
  writeStoredSeries,
} from './climate-source'
import { loadConfig, type ServerConfig } from './config'
import { GeoProxyService } from './geo-proxy'
import { resetStaticCaches } from './static-cache'

// Terrain, climatology and embankments are cached per location, so one test's
// stubbed upstream would otherwise answer the next test's question.
beforeEach(() => resetStaticCaches())

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

/** A full year of daily dates, with one spike on the given day-of-year. */
const yearOf = (year: number, days: number, spike: number, spikeDay = 100) => {
  const time: string[] = []
  const precipitation: Array<number | null> = []
  const start = Date.UTC(year, 0, 1)
  for (let d = 0; d < days; d++) {
    time.push(new Date(start + d * 86_400_000).toISOString().slice(0, 10))
    precipitation.push(d === spikeDay ? spike : 1)
  }
  return { time, precipitation }
}

describe('ERA5 archive request', () => {
  it('asks for a daily precipitation series ending at the last complete year', () => {
    const url = era5ArchiveUrl({ latitude: 36.0771, longitude: 139.9907 }, 2025)
    expect(url).toContain('archive-api.open-meteo.com')
    expect(url).toContain('daily=precipitation_sum')
    expect(url).toContain('start_date=1960-01-01')
    expect(url).toContain('end_date=2025-12-31')
  })
})

describe('annual maxima', () => {
  it('takes the largest day of each year', () => {
    const a = yearOf(2000, 366, 120)
    const b = yearOf(2001, 365, 90)
    const maxima = annualMaxima([...a.time, ...b.time], [...a.precipitation, ...b.precipitation])
    expect(maxima).toEqual([120, 90])
  })

  it('drops a part-year, which would bias the series low', () => {
    const full = yearOf(2000, 366, 120)
    const stub = yearOf(2001, 30, 90)
    const maxima = annualMaxima([...full.time, ...stub.time], [...full.precipitation, ...stub.precipitation])
    expect(maxima).toEqual([120])
  })

  it('tolerates scattered gaps but drops a year that is mostly missing', () => {
    const year = yearOf(2000, 366, 120)
    // 5% missing: still a usable year, and a gap is not a zero.
    const sparse = year.precipitation.map((v, i) => (i % 20 === 1 ? null : v))
    expect(annualMaxima(year.time, sparse)).toEqual([120])

    // A third missing is not a year worth taking a maximum from.
    const gappy = year.precipitation.map((v, i) => (i % 3 === 0 ? null : v))
    expect(annualMaxima(year.time, gappy)).toEqual([])
  })
})

interface Reply {
  readonly status: number
  readonly body: string
}

class StubProxy extends GeoProxyService {
  private readonly reply: Reply
  /** Every archive call this proxy was asked to make — the thing being economised. */
  public calls = 0

  constructor(config: ReturnType<typeof run<ServerConfig, never>>, reply: Reply) {
    super(config)
    this.reply = reply
  }

  override async fetchUpstream(_sourceId: string, targetUrl: string) {
    this.calls++
    return { ...this.reply, contentType: 'application/json', redactedUrl: targetUrl }
  }
}

const proxyWith = (reply: Reply) => new StubProxy(run(loadConfig({})), reply)

const AT = { latitude: 36.0771, longitude: 139.9907 }

describe('loading rainfall climatology', () => {
  const manyYears = () => {
    const time: string[] = []
    const precipitation: Array<number | null> = []
    for (let y = 1980; y <= 2024; y++) {
      // Spikes walk from 60 to 148 mm, giving the fit something to work with.
      const s = yearOf(y, 365, 60 + (y - 1980) * 2)
      time.push(...s.time)
      precipitation.push(...s.precipitation)
    }
    return JSON.stringify({ daily: { time, precipitation_sum: precipitation } })
  }

  it('fits a two-year rainfall from a long record', async () => {
    const result = await loadRainfallClimatology(proxyWith({ status: 200, body: manyYears() }), AT, false)
    expect(result.status).toBe('ok')
    expect(result.yearsOfRecord).toBe(45)
    // Spikes run 60..148 mm, so the two-year level sits inside that range.
    expect(result.rain2yrMm).toBeGreaterThan(60)
    expect(result.rain2yrMm).toBeLessThan(148)
  })

  it('refuses to fit a record too short to mean anything', async () => {
    const short = yearOf(2020, 365, 90)
    const body = JSON.stringify({ daily: { time: short.time, precipitation_sum: short.precipitation } })
    const result = await loadRainfallClimatology(proxyWith({ status: 200, body }), AT, false)
    expect(result.rain2yrMm).toBe(0)
    expect(result.status).toContain('need')
  })

  it('degrades rather than failing when the archive is unavailable', async () => {
    for (const reply of [
      { status: 503, body: '' },
      { status: 200, body: 'not json' },
      { status: 200, body: '{"error":true}' },
    ]) {
      const result = await loadRainfallClimatology(proxyWith(reply), AT, false)
      expect(result.rain2yrMm).toBe(0)
      expect(result.status).not.toBe('ok')
    }
  })

  it('does not reach for the network in fixture mode', async () => {
    const result = await loadRainfallClimatology(proxyWith({ status: 200, body: manyYears() }), AT, true)
    expect(result.rain2yrMm).toBe(0)
    expect(result.status).toContain('fixture')
  })

  describe('keeping the series between runs', () => {
    let dir = ''
    const NOW = new Date('2026-08-31T00:00:00Z')

    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'era5-')) })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    /** A fresh process: the in-memory cache is gone, the disk is not. */
    const restart = () => resetStaticCaches()

    it('asks the archive once, then never again for that location', async () => {
      const proxy = proxyWith({ status: 200, body: manyYears() })
      const first = await loadRainfallClimatology(proxy, AT, false, { cacheDir: dir, now: NOW })
      expect(first.status).toBe('ok')
      expect(first.retrievedFrom).toBe('archive')
      expect(proxy.calls).toBe(1)

      restart()
      const second = await loadRainfallClimatology(proxy, AT, false, { cacheDir: dir, now: NOW })
      expect(second.retrievedFrom).toBe('stored')
      expect(second.rain2yrMm).toBe(first.rain2yrMm)
      expect(second.yearsOfRecord).toBe(first.yearsOfRecord)
      expect(proxy.calls).toBe(1)
    })

    it('serves a stored series even when the archive is refusing every request', async () => {
      const proxy = proxyWith({ status: 200, body: manyYears() })
      const live = await loadRainfallClimatology(proxy, AT, false, { cacheDir: dir, now: NOW })

      restart()
      // Exactly what the daily cap returns, for requests of any size.
      const capped = proxyWith({ status: 429, body: '{"reason":"Daily API request limit exceeded"}' })
      const result = await loadRainfallClimatology(capped, AT, false, { cacheDir: dir, now: NOW })
      expect(result.status).toBe('ok')
      expect(result.rain2yrMm).toBe(live.rain2yrMm)
      expect(capped.calls).toBe(0)
    })

    it('stores the series rather than the fitted level, so the fit is not frozen', async () => {
      const proxy = proxyWith({ status: 200, body: manyYears() })
      await loadRainfallClimatology(proxy, AT, false, { cacheDir: dir, now: NOW })
      const file = readdirSync(dir)[0]!
      const record = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      expect(record.annualMaximaMm).toHaveLength(45)
      expect(record.firstYear).toBe(1960)
      expect(record.endYear).toBe(2025)
      expect(record.source).toContain('era5')
    })

    it('re-asks when the record has grown by a year', async () => {
      const proxy = proxyWith({ status: 200, body: manyYears() })
      await loadRainfallClimatology(proxy, AT, false, { cacheDir: dir, now: NOW })
      restart()
      await loadRainfallClimatology(proxy, AT, false, { cacheDir: dir, now: new Date('2027-01-02T00:00:00Z') })
      expect(proxy.calls).toBe(2)
    })

    it('never lets the cache be load-bearing: unreadable, absent or empty all fall through', async () => {
      expect(readStoredSeries(dir, AT, 2025)).toBeUndefined()
      writeFileSync(join(dir, '36.1_140.0_1960-2025.json'), 'not json at all')
      expect(readStoredSeries(dir, AT, 2025)).toBeUndefined()
      writeFileSync(join(dir, '36.1_140.0_1960-2025.json'), '{"annualMaximaMm":[]}')
      expect(readStoredSeries(dir, AT, 2025)).toBeUndefined()
      writeFileSync(join(dir, '36.1_140.0_1960-2025.json'), '{"annualMaximaMm":[10,"wet",30]}')
      expect(readStoredSeries(dir, AT, 2025)).toBeUndefined()

      // And a write to somewhere it cannot create does not throw.
      expect(() => writeStoredSeries('/proc/nowhere/era5', AT, 2025, [1, 2, 3])).not.toThrow()
    })

    it('is disabled by an empty directory, without touching the filesystem', async () => {
      const proxy = proxyWith({ status: 200, body: manyYears() })
      await loadRainfallClimatology(proxy, AT, false, { cacheDir: '', now: NOW })
      restart()
      await loadRainfallClimatology(proxy, AT, false, { cacheDir: '', now: NOW })
      expect(proxy.calls).toBe(2)
      expect(readdirSync(dir)).toHaveLength(0)
    })

    it('shares one series between nearby queries, as the in-memory cache does', async () => {
      const proxy = proxyWith({ status: 200, body: manyYears() })
      await loadRainfallClimatology(proxy, AT, false, { cacheDir: dir, now: NOW })
      restart()
      // 2 km away: the same tenth of a degree, and the same 66-year climate.
      const nearby = { latitude: AT.latitude + 0.01, longitude: AT.longitude + 0.01 }
      const result = await loadRainfallClimatology(proxy, nearby, false, { cacheDir: dir, now: NOW })
      expect(result.retrievedFrom).toBe('stored')
      expect(proxy.calls).toBe(1)
    })
  })
})
