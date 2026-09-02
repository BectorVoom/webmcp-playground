import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  classifyGlofasPixel,
  classifyGlofasRaster,
  GlofasFloodProvider,
  glofasMapUrl,
  GLOFAS_LAYER,
} from './glofas-flood'
import type { DecodedTile } from './jp/flood'

const DHAKA = { latitude: 23.8103, longitude: 90.4125 }

describe('glofasMapUrl', () => {
  /**
   * WMS 1.1.1 on purpose. The service advertises 1.3.0 and then answers a 1.3.0 GetMap with
   * `cannot unpack non-iterable NoneType object` — its own internal error, not a bad request.
   */
  it('asks in the dialect the service actually answers', () => {
    const url = new URL(glofasMapUrl([90.2, 23.6, 90.6, 24.0]))

    expect(url.hostname).toBe('ows.globalfloods.eu')
    expect(url.searchParams.get('version')).toBe('1.1.1')
    expect(url.searchParams.get('srs')).toBe('EPSG:4326')
    expect(url.searchParams.get('layers')).toBe(GLOFAS_LAYER)
    expect(url.searchParams.get('bbox')).toBe('90.2,23.6,90.6,24')
    expect(url.searchParams.get('transparent')).toBe('true')
  })
})

describe('classifyGlofasPixel', () => {
  /**
   * The distinction this whole classifier exists for.
   *
   * Sampling the layer showed `#3338FF` covering 54% of Lake Biwa and under 2% of the Fukui flood
   * plain, while the paler blues do the reverse — so the deep blue is the permanent water body the
   * layer's abstract mentions, not hazard. Painting it as hazard would report a lake as an area
   * that is going to flood.
   */
  it('reads the pale blues as the 100-year hazard extent', () => {
    expect(classifyGlofasPixel(184, 219, 255, 255)).toBe('hazard')
    expect(classifyGlofasPixel(154, 204, 255, 255)).toBe('hazard')
    expect(classifyGlofasPixel(103, 153, 255, 255)).toBe('hazard')
  })

  it('reads the deep blue as permanent water, not as hazard', () => {
    expect(classifyGlofasPixel(51, 56, 255, 255)).toBe('permanent-water')
  })

  it('treats the per-request quantisation shade as permanent water it edges', () => {
    // #3366FF appears as a sixth palette entry in some responses and not others.
    expect(classifyGlofasPixel(51, 102, 255, 255)).toBe('permanent-water')
  })

  it('reads transparency as outside the extent', () => {
    expect(classifyGlofasPixel(0, 0, 0, 0)).toBe('none')
  })

  it('refuses to guess at a colour that is not in the layer at all', () => {
    expect(classifyGlofasPixel(255, 0, 0, 255)).toBe('unreadable')
  })
})

const rasterOf = (colours: ReadonlyArray<readonly [number, number, number, number]>): DecodedTile => {
  const size = colours.length
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = colours[y]!
      const o = (y * size + x) * 4
      data[o] = c[0]
      data[o + 1] = c[1]
      data[o + 2] = c[2]
      data[o + 3] = c[3]
    }
  }
  return { data, width: size, height: size }
}

describe('classifyGlofasRaster', () => {
  it('keeps permanent water out of the hazard grid entirely', () => {
    const raster = rasterOf([
      [184, 219, 255, 255], // hazard
      [51, 56, 255, 255], // a lake
      [0, 0, 0, 0], // outside
      [255, 0, 0, 255], // not in the palette
    ])
    const { grid, hazardPixels, waterPixels, unreadablePixels } = classifyGlofasRaster(
      raster.data,
      raster.width,
      raster.height,
    )

    expect(hazardPixels).toBe(4)
    expect(waterPixels).toBe(4)
    expect(unreadablePixels).toBe(4)
    // A lake is not a hazard zone, so it becomes no zone at all rather than a class of its own.
    expect(grid.filter((c) => c === 'high')).toHaveLength(4)
    expect(grid.filter((c) => c === null)).toHaveLength(8)
    expect(grid.filter((c) => c === 'unclassified')).toHaveLength(4)
  })
})

const harness = (decoded: DecodedTile | null) => {
  const urls: Array<string> = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { upstreamUrl?: string }
    urls.push(body.upstreamUrl ?? '')
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
  }) as unknown as typeof fetch
  return { urls, provider: new GlofasFloodProvider(fetchImpl, async () => decoded) }
}

describe('GlofasFloodProvider', () => {
  it('reports the 100-year extent as a scenario, and never as a forecast', async () => {
    const { provider } = harness(rasterOf([[184, 219, 255, 255], [154, 204, 255, 255]]))
    const res = await Effect.runPromise(provider.zonesWithin({ at: DHAKA, radiusKm: 20 }))

    expect(res.zones.length).toBeGreaterThan(0)
    for (const zone of res.zones) {
      expect(zone.kind.kind).toBe('scenario')
      if (zone.kind.kind === 'scenario') expect(zone.kind.designEvent).toContain('100-year')
      // GloFAS publishes an extent for this layer, not a depth grid.
      expect(zone.depth).toBeUndefined()
      expect(zone.provenance.attribution).toContain('GloFAS')
    }
  })

  it('draws no zone for a lake', async () => {
    const { provider } = harness(rasterOf([[51, 56, 255, 255], [51, 56, 255, 255]]))
    const res = await Effect.runPromise(provider.zonesWithin({ at: DHAKA, radiusKm: 20 }))

    expect(res.zones).toEqual([])
    expect(res.coverage.detail).toContain('Permanent lakes')
  })

  it('says an area outside the extent is outside it, and why that is not proof of safety', async () => {
    const { provider } = harness(rasterOf([[0, 0, 0, 0], [0, 0, 0, 0]]))
    const res = await Effect.runPromise(provider.zonesWithin({ at: DHAKA, radiusKm: 20 }))

    expect(res.zones).toEqual([])
    expect(res.coverage.state).toBe('full')
    expect(res.coverage.detail).toContain('misses small watercourses')
  })

  it('does not report an undecodable raster as an area outside the extent', async () => {
    const { provider } = harness(null)
    const res = await Effect.runPromise(provider.zonesWithin({ at: DHAKA, radiusKm: 20 }))

    expect(res.coverage.state).toBe('none')
    expect(res.coverage.detail).toContain('not a report that the area is outside it')
  })

  it('queries the bbox of the requested circle', async () => {
    const { urls, provider } = harness(rasterOf([[0, 0, 0, 0]]))
    await Effect.runPromise(provider.zonesWithin({ at: DHAKA, radiusKm: 20 }))

    const bbox = new URL(urls[0]!).searchParams.get('bbox')!.split(',').map(Number)
    expect(bbox[0]).toBeLessThan(DHAKA.longitude)
    expect(bbox[2]).toBeGreaterThan(DHAKA.longitude)
    expect(bbox[1]).toBeLessThan(DHAKA.latitude)
    expect(bbox[3]).toBeGreaterThan(DHAKA.latitude)
  })
})
