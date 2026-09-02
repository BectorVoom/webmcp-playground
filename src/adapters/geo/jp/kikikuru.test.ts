import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  JpKikikuruProvider,
  KIKIKURU_LEGEND,
  KIKIKURU_LEVEL_LABEL,
  KIKIKURU_TILE_URL,
  parseJmaTimestamp,
  pickLatestTime,
} from './kikikuru'
import type { DecodedTile } from './flood'
import times from '../../../../fixtures/geo/jp/flood/upstream/jma-kikikuru-targettimes.json'
import tile from '../../../../fixtures/geo/jp/flood/upstream/jma-kikikuru-inund-z12.json'
import paletteTile from '../../../../fixtures/geo/jp/flood/upstream/jma-kikikuru-palette-z10.json'

const FUKUI = { latitude: 36.0621, longitude: 136.2222 }

/** Reads the palette straight out of a recorded PNG, which is where the legend came from. */
const paletteOf = (base64: string): Array<{ hex: string; alpha: number }> => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const view = new DataView(bytes.buffer)
  let offset = 8
  let plte: Uint8Array | undefined
  let trns: Uint8Array | undefined
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8))
    if (type === 'PLTE') plte = bytes.slice(offset + 8, offset + 8 + length)
    if (type === 'tRNS') trns = bytes.slice(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IEND') break
  }
  if (!plte) return []
  return Array.from({ length: plte.length / 3 }, (_, i) => ({
    hex:
      '#' +
      [plte![i * 3], plte![i * 3 + 1], plte![i * 3 + 2]]
        .map((v) => (v ?? 0).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase(),
    alpha: trns && i < trns.length ? (trns[i] ?? 255) : 255,
  }))
}

describe('キキクル risk palette', () => {
  /**
   * The legend is pinned to JMA's own bytes rather than to its documentation.
   *
   * These tiles are 4-bit palette PNGs, and the `PLTE` chunk carries the entire risk table whatever
   * the tile happens to contain — so this holds even though the recorded tile was captured on a
   * calm day and is level 1 from edge to edge. The last colour table in this codebase that came
   * from documentation instead of from bytes was wrong on five of its six rows.
   */
  it('matches the palette JMA ships inside the tile', () => {
    const opaque = paletteOf(paletteTile.base64).filter((entry) => entry.alpha >= 32)
    const legend = KIKIKURU_LEGEND.map(
      (e) => '#' + [e.r, e.g, e.b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase(),
    )

    expect(opaque.map((e) => e.hex)).toEqual(legend)
  })

  it('leaves level 1 as transparency rather than giving it a colour', () => {
    const palette = paletteOf(paletteTile.base64)
    expect(palette.filter((e) => e.alpha < 32).length).toBeGreaterThan(0)
  })

  it('has a recorded tile from a calm day that carries no risk at all', () => {
    // JMA emits truecolour for a wholly empty tile and a palette PNG once there is content, so
    // this one has no PLTE to read — it pins the quiet-day path instead.
    expect(paletteOf(tile.base64)).toEqual([])
  })

  it('orders the four levels by severity', () => {
    expect(KIKIKURU_LEGEND.map((e) => e.hazardClass)).toEqual(['low', 'moderate', 'high', 'extreme'])
  })

  it('names each level the way 気象庁 does, for a reader in Japan', () => {
    expect(KIKIKURU_LEVEL_LABEL.high).toContain('危険')
    expect(KIKIKURU_LEVEL_LABEL.extreme).toContain('災害切迫')
  })
})

describe('parseJmaTimestamp', () => {
  /**
   * The `jmatile` risk index stamps in UTC while most of JMA's other `bosai` JSON uses JST. Read as
   * JST every reading lands nine hours in the past — a plausible-looking number that marks a feed
   * thirty seconds old as badly stale, and would have this tool telling a reader the danger picture
   * was from this morning.
   */
  it('reads the index stamps as UTC', () => {
    expect(parseJmaTimestamp('20260830013000')).toBe(Date.parse('2026-08-30T01:30:00Z'))
  })

  it('refuses a stamp that is not one', () => {
    expect(parseJmaTimestamp('not-a-time')).toBeUndefined()
    expect(parseJmaTimestamp('202608300130')).toBeUndefined()
  })
})

describe('pickLatestTime', () => {
  it('takes the newest entry carrying both hazards, from the real index', () => {
    const picked = pickLatestTime(times, ['inund', 'flood'])

    expect(picked).toBeDefined()
    expect(picked?.member).toBe('immed0')
    const newest = Math.max(
      ...times.filter((t) => t.elements.includes('inund')).map((t) => parseJmaTimestamp(t.validtime) ?? 0),
    )
    expect(parseJmaTimestamp(picked!.validtime)).toBe(newest)
  })

  it('picks by timestamp, not by position in the array', () => {
    const shuffled = [...times].reverse()
    expect(pickLatestTime(shuffled, ['inund'])?.validtime).toBe(pickLatestTime(times, ['inund'])?.validtime)
  })

  it('skips entries that do not carry the elements asked for', () => {
    const entries = [
      { basetime: '20260830010000', validtime: '20260830010000', member: 'none', elements: ['land'] },
    ]
    expect(pickLatestTime(entries, ['inund'])).toBeUndefined()
  })
})

describe('KIKIKURU_TILE_URL', () => {
  it('addresses a tile the way JMA indexes it', () => {
    const url = KIKIKURU_TILE_URL(
      { basetime: '20260830014000', validtime: '20260830014000', member: 'immed0' },
      'inund',
      12,
      3597,
      1607,
    )
    expect(url).toBe(
      'https://www.jma.go.jp/bosai/jmatile/data/risk/20260830014000/immed0/20260830014000/surf/inund/12/3597/1607.png',
    )
  })
})

/** A tile painted entirely in one risk colour, using the palette read out of JMA's own bytes. */
const levelTile = (level: 2 | 3 | 4 | 5, size = 8): DecodedTile => {
  const entry = KIKIKURU_LEGEND[level - 2]!
  const data = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = entry.r
    data[i * 4 + 1] = entry.g
    data[i * 4 + 2] = entry.b
    data[i * 4 + 3] = 255
  }
  return { data, width: size, height: size }
}

const harness = (decoded: DecodedTile | null, opts: { tileStatus?: number } = {}) => {
  const urls: Array<string> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { upstreamUrl?: string }
    urls.push(body.upstreamUrl ?? String(input))
    if ((body.upstreamUrl ?? '').includes('targetTimes.json')) {
      return new Response(JSON.stringify(times))
    }
    if (opts.tileStatus && opts.tileStatus !== 200) {
      return new Response('nope', { status: opts.tileStatus })
    }
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
  }) as unknown as typeof fetch
  return { urls, provider: new JpKikikuruProvider(fetchImpl, async () => decoded) }
}

describe('JpKikikuruProvider', () => {
  it('reports a real-time risk level as a forecast, never as a scenario', async () => {
    const { provider } = harness(levelTile(4))
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    expect(res.zones.length).toBeGreaterThan(0)
    for (const zone of res.zones) {
      // ADR-2: what is dangerous now and what a design event would flood are different types.
      expect(zone.kind.kind).toBe('forecast')
      expect(zone.provenance.issuedAt).toBeGreaterThan(0)
    }
  })

  it('carries the risk level as a hazard class and never as a depth', async () => {
    const { provider } = harness(levelTile(4))
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    expect(res.zones[0]?.hazardClass).toBe('high')
    // A risk level is not a water depth, and inventing one would be the same failure as
    // inventing a hazard zone.
    expect(res.zones.every((z) => z.depth === undefined)).toBe(true)
  })

  it('rises through the levels', async () => {
    for (const [level, expected] of [[2, 'low'], [3, 'moderate'], [4, 'high'], [5, 'extreme']] as const) {
      const { provider } = harness(levelTile(level))
      const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))
      expect(res.zones[0]?.hazardClass, `level ${level}`).toBe(expected)
    }
  })

  it('asks for both 浸水害 and 洪水害', async () => {
    const { urls, provider } = harness(levelTile(3))
    await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    expect(urls.some((u) => u.includes('/surf/inund/'))).toBe(true)
    expect(urls.some((u) => u.includes('/surf/flood/'))).toBe(true)
  })

  it('reads a quiet area as quiet, not as an outage', async () => {
    const transparent: DecodedTile = {
      data: new Uint8ClampedArray(8 * 8 * 4),
      width: 8,
      height: 8,
    }
    const { provider } = harness(transparent)
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    expect(res.zones).toEqual([])
    expect(res.coverage.state).toBe('full')
    expect(res.coverage.detail).toContain('level 1')
  })

  it('says so when every tile request fails, and does not call that quiet', async () => {
    const { provider } = harness(levelTile(3), { tileStatus: 500 })
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    expect(res.coverage.state).toBe('none')
    expect(res.coverage.detail).toContain('Every')
  })

  it('falls back rather than failing when the browser cannot decode a raster', async () => {
    const { provider } = harness(null)
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    expect(res.zones).toEqual([])
    expect(res.coverage.state).toBe('none')
    expect(res.coverage.detail).toContain('not a report that the risk is low')
  })
})
