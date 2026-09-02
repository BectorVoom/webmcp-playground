import { Effect } from 'effect'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, type ServerConfig } from './config'
import { GeoProxyService } from './geo-proxy'
import { loadLevees, overpassLeveeQuery, readStoredLevees, writeStoredLevees } from './levee-source'
import { resetStaticCaches } from './static-cache'
import type { BBox } from '../src/domain/geo'

// Embankments are cached per query box, so one test's stubbed reply would
// otherwise answer the next test's question.
beforeEach(() => resetStaticCaches())

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

const BOX: BBox = [139.9, 36.0, 140.1, 36.2]

const overpassReply = (ways: number): string =>
  JSON.stringify({
    elements: Array.from({ length: ways }, (_, i) => ({
      type: 'way',
      id: i,
      tags: { man_made: 'dyke' },
      geometry: [
        { lon: 139.95, lat: 36.05 + i * 0.001 },
        { lon: 139.97, lat: 36.05 + i * 0.001 },
      ],
    })),
  })

interface Reply {
  readonly status: number
  readonly body: string
}

class StubProxy extends GeoProxyService {
  private readonly reply: Reply
  /** Every Overpass call this proxy was asked to make — the thing being economised. */
  public calls = 0

  constructor(config: ServerConfig, reply: Reply) {
    super(config)
    this.reply = reply
  }

  override async fetchUpstream(_sourceId: string, targetUrl: string) {
    this.calls++
    return { ...this.reply, contentType: 'application/json', redactedUrl: targetUrl }
  }
}

const proxyWith = (reply: Reply) => new StubProxy(run(loadConfig({})), reply)

describe('the Overpass query', () => {
  it('asks for purpose-built dykes and the roads and railways that act as ones', () => {
    const query = overpassLeveeQuery(BOX)
    expect(query).toContain('man_made')
    expect(query).toContain('barrier"="embankment')
    expect(query).toContain('36.00000,139.90000,36.20000,140.10000')
  })
})

describe('the embankment store', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'levee-store-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads back what it wrote', () => {
    writeStoredLevees(dir, BOX, {
      segments: [{ points: [[139.95, 36.05], [139.97, 36.05]], heightM: 4 }],
      wayCount: 1,
      withRecordedHeight: 1,
      status: 'ok',
    })
    const stored = readStoredLevees(dir, BOX)
    expect(stored?.wayCount).toBe(1)
    expect(stored?.segments[0]?.heightM).toBe(4)
  })

  it('answers a second query from disk rather than from Overpass', async () => {
    const proxy = proxyWith({ status: 200, body: overpassReply(3) })

    const first = await loadLevees(proxy, BOX, false, { cacheDir: dir })
    expect(first.wayCount).toBe(3)
    expect(first.retrievedFrom).toBe('overpass')
    expect(proxy.calls).toBe(1)

    // A restart loses the in-memory cache but must not cost another megabyte of
    // Overpass — that is the whole point of the store.
    resetStaticCaches()
    const second = await loadLevees(proxy, BOX, false, { cacheDir: dir })
    expect(second.wayCount).toBe(3)
    expect(second.retrievedFrom).toBe('stored')
    expect(second.status).toBe('ok')
    expect(proxy.calls).toBe(1)
  })

  it('never stores an outage', async () => {
    const proxy = proxyWith({ status: 504, body: '' })
    const result = await loadLevees(proxy, BOX, false, { cacheDir: dir })

    expect(result.status).toBe('overpass HTTP 504')
    expect(result.retrievedFrom).toBe('none')
    // Remembering this would turn a transient gateway timeout into a permanent
    // "this floodplain has no defences", which is the unsafe direction.
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('is disabled by an empty directory, and still answers', async () => {
    const proxy = proxyWith({ status: 200, body: overpassReply(2) })
    const result = await loadLevees(proxy, BOX, false, { cacheDir: '' })

    expect(result.wayCount).toBe(2)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('fetches nothing at all in fixture mode', async () => {
    const proxy = proxyWith({ status: 200, body: overpassReply(2) })
    const result = await loadLevees(proxy, BOX, true, { cacheDir: dir })

    expect(result.wayCount).toBe(0)
    expect(result.status).toContain('fixture')
    expect(proxy.calls).toBe(0)
  })
})
