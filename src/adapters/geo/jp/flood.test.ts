import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  cellMetresForRadius,
  DEFAULT_TILE_CAP,
  GSI_TILE_URL,
  JpFloodProvider,
  setGsiTileCap,
  type DecodedTile,
} from './flood'
import { GSI_FLOOD_LEGEND } from '../../../lib/geometry/raster'
import { fukuiStationTile } from '../../../lib/geometry/testing/tile-fixture'

const FUKUI = { latitude: 36.0619, longitude: 136.2233 }

const legendColour = (hazardClass: string) => {
  const entry = GSI_FLOOD_LEGEND.find((l) => l.hazardClass === hazardClass)!
  return [entry.r, entry.g, entry.b] as const
}

/**
 * A synthetic GSI tile: a solid block of one legend colour surrounded by transparent pixels,
 * which is what an inundation polygon looks like once GSI has rasterised it.
 */
const tileOf = (hazardClass: string, size = 16): DecodedTile => {
  const data = new Uint8ClampedArray(size * size * 4)
  const [r, g, b] = legendColour(hazardClass)
  for (let y = 4; y < size - 4; y++) {
    for (let x = 4; x < size - 4; x++) {
      const offset = (y * size + x) * 4
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = 255
    }
  }
  return { data, width: size, height: size }
}

const transparentTile = (size = 16): DecodedTile => ({
  data: new Uint8ClampedArray(size * size * 4),
  width: size,
  height: size,
})

interface Harness {
  readonly status?: number
  readonly decoded?: DecodedTile | null
  readonly tileCap?: number
}

const harness = (options: Harness = {}) => {
  const urls: Array<string> = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(new Uint8Array([137, 80, 78, 71]), { status: options.status ?? 200 })
  }) as unknown as typeof fetch
  const decoder = async () => (options.decoded === undefined ? tileOf('high') : options.decoded)
  return { urls, provider: new JpFloodProvider(fetchImpl, decoder, options.tileCap) }
}

describe('cellMetresForRadius', () => {
  /**
   * Vertices after simplification track the number of separate polygons, not their intricacy, and
   * polygon count grows with area over cell squared. Holding the cell proportional to the radius
   * is what keeps a 20 km query affordable now that the cap lets it cover the whole circle.
   */
  it('coarsens as the query widens, so the rendered layer costs about the same either way', () => {
    expect(cellMetresForRadius(20)).toBeGreaterThan(cellMetresForRadius(5))
    expect(cellMetresForRadius(10)).toBeGreaterThan(cellMetresForRadius(1))
  })

  it('never goes finer than 40 m, where a dense tile costs ten times as much to vectorise', () => {
    expect(cellMetresForRadius(1)).toBe(40)
    expect(cellMetresForRadius(0.1)).toBe(40)
  })

  it('never goes coarser than 120 m, and survives a nonsense radius', () => {
    expect(cellMetresForRadius(1000)).toBe(120)
    expect(cellMetresForRadius(Number.NaN)).toBeLessThanOrEqual(120)
  })
})

describe('JpFloodProvider (live GSI hazard raster)', () => {
  it('fetches hazard tiles for the query area through the tile proxy', async () => {
    const { urls, provider } = harness()
    await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 5 }))

    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith('/api/geo/tiles/jp-flood/14/'))).toBe(true)
    expect(urls[0]).toMatch(/^\/api\/geo\/tiles\/jp-flood\/14\/\d+\/\d+\.png$/)
    expect(GSI_TILE_URL(14, 1, 2)).toBe('/api/geo/tiles/jp-flood/14/1/2.png')
  })

  it('never asks for more tiles than the cap allows', async () => {
    const { urls, provider } = harness({ tileCap: 24 })
    await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 20 }))

    expect(urls.length).toBeLessThanOrEqual(24)
  })

  it('covers the whole circle at the widest radius the tools allow', async () => {
    // 441 tiles at zoom 14. The default cap used to be 64, so 85% of a 20 km query was never
    // looked at — the reason the cap is now high enough to finish the job (R2.5, R1.9).
    const { urls, provider } = harness()
    await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 20 }))

    expect(urls.length).toBe(441)
    expect(DEFAULT_TILE_CAP).toBeGreaterThanOrEqual(441)
  })

  it('takes its cap from the server, which is what pays for the requests', async () => {
    setGsiTileCap(9)
    try {
      const { urls, provider } = harness()
      await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 20 }))
      expect(urls.length).toBe(9)
    } finally {
      setGsiTileCap(DEFAULT_TILE_CAP)
    }
  })

  it('turns legend-coloured pixels into hazard zones', async () => {
    const { provider } = harness()
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    expect(res.zones.length).toBeGreaterThan(0)
    expect(res.zones.every((z) => z.hazardClass === 'high')).toBe(true)
    expect(res.zones[0]?.depth).toEqual({ minMetres: 3.0, maxMetres: 5.0 })
    expect(res.zones[0]?.kind.kind).toBe('scenario')
  })

  it('attributes zones to GSI and marks them live', async () => {
    const { provider } = harness()
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    const provenance = res.zones[0]!.provenance
    expect(provenance.mode).toBe('live')
    expect(provenance.sourceId).toBe('jp.gsi.flood-l2')
    expect(provenance.upstreamUrl).toContain('disaportaldata.gsi.go.jp')
    expect(provenance.attribution).toContain('国土地理院')
  })

  it('reads a transparent tile as no inundation, and says what that means', async () => {
    const { provider } = harness({ decoded: transparentTile() })
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    expect(res.zones).toEqual([])
    expect(res.coverage.state).toBe('full')
    expect(res.coverage.detail).toContain('not that it cannot flood')
  })

  it('treats a 404 tile as unmapped area rather than a failure', async () => {
    const { provider } = harness({ status: 404 })
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    expect(res.zones).toEqual([])
    expect(res.coverage.state).toBe('full')
    expect(res.coverage.failedSources).toEqual([])
  })

  it('fails when no tile could be reached, rather than reporting no flood risk', async () => {
    const { provider } = harness({ status: 502 })
    const exit = await Effect.runPromiseExit(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    expect(exit._tag).toBe('Failure')
  })

  it('falls back to fixtures where the browser cannot decode a raster at all', async () => {
    const { provider } = harness({ decoded: null })
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    // Recorded GSI geometry for Fukui now ships in the fixture, so the fallback has something
    // real-shaped to serve — and it is labelled simulated, as everything in fixture mode is.
    expect(res.zones.length).toBeGreaterThan(0)
    expect(res.zones.every((z) => z.provenance.mode === 'fixture')).toBe(true)
  })

  it('says which mode to switch to when the fixtures reach nowhere near the query', async () => {
    const { provider } = harness({ decoded: null })
    // The Sea of Japan, 200 km off Fukui: no recorded area comes close.
    const res = await Effect.runPromise(
      provider.zonesWithin({ at: { latitude: 37.6, longitude: 134.5 }, radiusKm: 2 }),
    )

    expect(res.zones).toEqual([])
    expect(res.coverage.reason).toBe('no_data_for_area')
    expect(res.coverage.detail).toContain('GEO_DATA_MODE=live')
  })

  /**
   * The end of the path that was broken: a real GSI tile, through the real classifier and the real
   * vectoriser, out as zones. Every other case here feeds the provider a solid block of one colour
   * a few pixels across, which is why the query hanging on real tiles never showed up.
   */
  describe('against a real GSI tile', () => {
    const realTileHarness = () => {
      const fetchImpl = (async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 })) as unknown as typeof fetch
      const decoded = fukuiStationTile()
      return new JpFloodProvider(fetchImpl, async () => decoded)
    }

    it('returns zones instead of hanging on a tile with thousands of pixel runs', async () => {
      const started = Date.now()
      const result = await Effect.runPromise(
        realTileHarness().zonesWithin({ at: FUKUI, radiusKm: 2 }),
      )

      expect(result.zones.length).toBeGreaterThan(0)
      expect(Date.now() - started).toBeLessThan(3_000)
    })

    it('keeps 5–10 m water in its own band rather than folding it into 3–5 m', async () => {
      const result = await Effect.runPromise(
        realTileHarness().zonesWithin({ at: FUKUI, radiusKm: 2 }),
      )

      const extreme = result.zones.find((z) => z.hazardClass === 'extreme')
      expect(extreme).toBeDefined()
      expect(extreme?.depth?.minMetres).toBe(5)
      expect(result.zones.map((z) => z.hazardClass).sort()).toEqual([
        'extreme',
        'high',
        'low',
        'moderate',
      ])
    })
  })

  it('says so when inundation is painted in a colour outside the published legend', async () => {
    // #F8E1A6 is painted in a handful of GSI tiles and appears in no published legend.
    const size = 16
    const data = new Uint8ClampedArray(size * size * 4)
    for (let i = 0; i < size * size; i++) {
      data[i * 4] = 248
      data[i * 4 + 1] = 225
      data[i * 4 + 2] = 166
      data[i * 4 + 3] = 255
    }
    const fetchImpl = (async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 })) as unknown as typeof fetch
    const provider = new JpFloodProvider(fetchImpl, async () => ({ data, width: size, height: size }))

    const result = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 2 }))

    expect(result.coverage.state).toBe('partial')
    expect(result.coverage.detail).toContain('outside the published GSI depth legend')
  })

  it('reports a partial map when the tile cap bites', async () => {
    const { provider } = harness({ tileCap: 16 })
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 20 }))

    expect(res.coverage.state).toBe('partial')
    expect(res.coverage.reason).toBe('tile_cap')
  })

  it('reports full coverage at the default cap, where nothing was left out', async () => {
    const { provider } = harness()
    const res = await Effect.runPromise(provider.zonesWithin({ at: FUKUI, radiusKm: 20 }))

    expect(res.coverage.state).toBe('full')
  })
})
