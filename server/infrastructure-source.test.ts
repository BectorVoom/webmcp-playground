import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeoProxyService } from './geo-proxy'
import {
  INFRASTRUCTURE_SOURCE_ID,
  loadInfrastructure,
  overpassInfrastructureQuery,
  parseOverpassInfrastructure,
} from './infrastructure-source'
import { resetStaticCaches } from './static-cache'

beforeEach(() => resetStaticCaches())

describe('the Overpass flood-infrastructure query', () => {
  it('asks for dams, storm drainage, culverts, and building relations', () => {
    const query = overpassInfrastructureQuery([138, 36.5, 138.5, 36.9])
    expect(query).toContain('way["waterway"="dam"]')
    expect(query).toContain('node["man_made"="storm_drain"]')
    expect(query).toContain('way["sewer"~"^(storm|combined)$"]')
    expect(query).toContain('way["tunnel"="culvert"]')
    expect(query).toContain('relation["building"]')
  })

  it('orders the bbox south, west, north, east', () => {
    expect(overpassInfrastructureQuery([138, 36.5, 138.5, 36.9])).toContain(
      '36.50000,138.00000,36.90000,138.50000',
    )
  })
})

describe('parsing mapped flood infrastructure', () => {
  it('separates dams, drainage features, and building footprints', () => {
    const parsed = parseOverpassInfrastructure(JSON.stringify({
      elements: [
        {
          type: 'way',
          tags: { waterway: 'dam' },
          geometry: [{ lon: 1, lat: 2 }, { lon: 1.1, lat: 2.1 }],
        },
        { type: 'node', tags: { man_made: 'storm_drain' }, lon: 1.2, lat: 2.2 },
        {
          type: 'way',
          tags: { building: 'residential' },
          geometry: [
            { lon: 1, lat: 2 },
            { lon: 1.01, lat: 2 },
            { lon: 1.01, lat: 2.01 },
          ],
        },
      ],
    }))

    expect(parsed?.damElements).toBe(1)
    expect(parsed?.drainElements).toBe(1)
    expect(parsed?.buildingElements).toBe(1)
    expect(parsed?.dams[0]!.points).toHaveLength(2)
    expect(parsed?.drains[0]!.points).toEqual([[1.2, 2.2]])
    expect(parsed?.buildings[0]!.rings).toHaveLength(1)
  })

  it('stitches relation members and keeps an inner building courtyard', () => {
    const parsed = parseOverpassInfrastructure(JSON.stringify({
      elements: [{
        type: 'relation',
        tags: { building: 'yes' },
        members: [
          { role: 'outer', geometry: [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }] },
          { role: 'outer', geometry: [{ lon: 1, lat: 0 }, { lon: 1, lat: 1 }, { lon: 0, lat: 0 }] },
          {
            role: 'inner',
            geometry: [
              { lon: 0.2, lat: 0.2 },
              { lon: 0.4, lat: 0.2 },
              { lon: 0.2, lat: 0.2 },
            ],
          },
        ],
      }],
    }))
    expect(parsed?.buildingElements).toBe(1)
    expect(parsed?.buildings[0]!.rings).toHaveLength(2)
  })

  it('distinguishes an empty reply from an unreadable one', () => {
    expect(parseOverpassInfrastructure('not json')).toBeNull()
    expect(parseOverpassInfrastructure('{}')).toBeNull()
    expect(parseOverpassInfrastructure('{"elements":[]}')).toMatchObject({
      dams: [],
      drains: [],
      buildings: [],
      truncated: false,
    })
  })
})

describe('loading mapped flood infrastructure', () => {
  const bbox = [138, 36.5, 138.5, 36.9] as const

  const proxyWith = (body: string, status = 200) => {
    const fetchUpstream = vi.fn(async () => ({
      status,
      body,
      contentType: 'application/json',
      redactedUrl: 'https://overpass-api.de/api/interpreter',
    }))
    return {
      proxy: { fetchUpstream } as unknown as GeoProxyService,
      fetchUpstream,
    }
  }

  it('does not touch Overpass in fixture mode', async () => {
    const { proxy, fetchUpstream } = proxyWith('{"elements":[]}')
    const result = await loadInfrastructure(proxy, bbox, true)
    expect(fetchUpstream).not.toHaveBeenCalled()
    expect(result.status).toContain('fixture')
    expect(result.retrievedFrom).toBe('none')
  })

  it('caches a good reply for the same model box', async () => {
    const { proxy, fetchUpstream } = proxyWith(JSON.stringify({
      elements: [{
        type: 'node',
        tags: { waterway: 'dam' },
        lon: 138.2,
        lat: 36.7,
      }],
    }))
    const first = await loadInfrastructure(proxy, bbox, false)
    const second = await loadInfrastructure(proxy, bbox, false)
    expect(fetchUpstream).toHaveBeenCalledTimes(2)
    expect(fetchUpstream).toHaveBeenCalledWith(
      INFRASTRUCTURE_SOURCE_ID,
      expect.stringContaining('https://overpass-api.de/api/interpreter?data='),
      expect.any(Object),
    )
    expect(first.damElements).toBe(1)
    expect(second).toBe(first)
  })

  it('never caches an unreadable reply as a confidently empty map', async () => {
    const { proxy, fetchUpstream } = proxyWith('not json')
    const first = await loadInfrastructure(proxy, bbox, false)
    const second = await loadInfrastructure(proxy, bbox, false)
    expect(fetchUpstream).toHaveBeenCalledTimes(4)
    expect(first.status).toContain('unreadable')
    expect(second.retrievedFrom).toBe('none')
  })

  it('subdivides a capped reply and deduplicates features crossing the boundary', async () => {
    const capped = JSON.stringify({
      elements: Array.from({ length: 20_000 }, (_, id) => ({
        id,
        type: 'way',
        tags: { building: 'yes' },
        geometry: [{ lon: 138.1, lat: 36.6 }, { lon: 138.11, lat: 36.6 }, { lon: 138.1, lat: 36.61 }],
      })),
    })
    const child = JSON.stringify({
      elements: [
        { type: 'node', id: 1, tags: { waterway: 'dam' }, lon: 138.25, lat: 36.7 },
        {
          type: 'way',
          id: 2,
          tags: { building: 'yes' },
          geometry: [{ lon: 138.24, lat: 36.7 }, { lon: 138.26, lat: 36.7 }, { lon: 138.25, lat: 36.71 }],
        },
      ],
    })
    const fetchUpstream = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: child })
      .mockResolvedValueOnce({ status: 200, body: capped })
      .mockResolvedValue({ status: 200, body: child })
    const proxy = { fetchUpstream } as unknown as GeoProxyService

    const result = await loadInfrastructure(proxy, bbox, false)

    expect(fetchUpstream).toHaveBeenCalledTimes(4)
    expect(result).toMatchObject({
      status: 'ok',
      truncated: false,
      damElements: 1,
      buildingElements: 1,
    })
  })

  it('subdivides a gateway-timed-out box instead of retrying the same query', async () => {
    const child = JSON.stringify({ elements: [] })
    const fetchUpstream = vi.fn()
      .mockResolvedValueOnce({ status: 504, body: '' })
      .mockResolvedValue({ status: 200, body: child })
    const proxy = { fetchUpstream } as unknown as GeoProxyService

    const result = await loadInfrastructure(proxy, bbox, false)

    expect(fetchUpstream).toHaveBeenCalledTimes(4)
    expect(result).toMatchObject({ status: 'ok', truncated: false, retrievedFrom: 'overpass' })
    const firstUrl = fetchUpstream.mock.calls[0]![1] as string
    const childUrl = fetchUpstream.mock.calls[1]![1] as string
    expect(childUrl).not.toBe(firstUrl)
  })
})
