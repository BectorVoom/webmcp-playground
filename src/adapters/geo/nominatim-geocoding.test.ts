import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  buildNominatimUrl,
  classifyPlace,
  NominatimGeocodingProvider,
  relativeConfidence,
} from './nominatim-geocoding'
import fukuiStation from '../../../fixtures/geo/global/geocode/upstream/nominatim-fukui-station.json'
import springfield from '../../../fixtures/geo/global/geocode/upstream/nominatim-springfield.json'
import noMatch from '../../../fixtures/geo/global/geocode/upstream/nominatim-no-match.json'

/** Stands in for the server proxy, recording what the adapter asked it to fetch. */
const stubProxy = (body: unknown, status = 200) => {
  const calls: Array<Record<string, unknown>> = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const search = (body: unknown, text: string, extra = {}) => {
  const { calls, fetchImpl } = stubProxy(body)
  return Effect.runPromise(
    new NominatimGeocodingProvider(fetchImpl).search({ text, ...extra }),
  ).then((result) => ({ result, calls }))
}

describe('buildNominatimUrl', () => {
  it('asks for the jsonv2 shape the parser expects', () => {
    const url = new URL(buildNominatimUrl({ text: 'Fukui Station' }))
    expect(url.hostname).toBe('nominatim.openstreetmap.org')
    expect(url.searchParams.get('q')).toBe('Fukui Station')
    expect(url.searchParams.get('format')).toBe('jsonv2')
    expect(url.searchParams.get('addressdetails')).toBe('1')
    expect(url.searchParams.get('limit')).toBe('5')
  })

  it('caps the result count at what the usage policy tolerates', () => {
    const url = new URL(buildNominatimUrl({ text: 'Station', limit: 500 }))
    expect(url.searchParams.get('limit')).toBe('10')
    expect(new URL(buildNominatimUrl({ text: 'Station', limit: 0 })).searchParams.get('limit')).toBe('1')
  })

  it('biases towards a point without bounding results to it', () => {
    const url = new URL(
      buildNominatimUrl({ text: 'Station', near: { latitude: 36.06, longitude: 136.22 } }),
    )
    // lon,lat,lon,lat — the order Nominatim reads a viewbox in.
    expect(url.searchParams.get('viewbox')).toBe('135.7700,35.6100,136.6700,36.5100')
    expect(url.searchParams.get('bounded')).toBe('0')
  })
})

describe('classifyPlace', () => {
  it('separates a point you can stand at from an area you cannot', () => {
    expect(classifyPlace({ category: 'railway', type: 'station' })).toBe('station')
    expect(classifyPlace({ category: 'building', type: 'train_station' })).toBe('station')
    expect(classifyPlace({ category: 'boundary', type: 'administrative' })).toBe('area')
    expect(classifyPlace({ category: 'place', type: 'city' })).toBe('settlement')
    expect(classifyPlace({ category: 'amenity', type: 'hospital' })).toBe('poi')
    expect(classifyPlace({ category: 'highway', type: 'residential' })).toBe('address')
    expect(classifyPlace({})).toBe('other')
  })
})

describe('relativeConfidence', () => {
  it('scores each candidate against the best answer to the same query, not against the world', () => {
    // A modest station that is the only sensible answer must not read as a weak one.
    expect(relativeConfidence(0.4677, 0.4677, 0)).toBe(0.95)
    expect(relativeConfidence(0.25, 0.5, 1)).toBe(0.48)
  })

  it('falls back to the order Nominatim returned when importance is missing', () => {
    expect(relativeConfidence(undefined, undefined, 0)).toBe(0.9)
    expect(relativeConfidence(undefined, undefined, 1)).toBe(0.78)
    expect(relativeConfidence(undefined, undefined, 9)).toBe(0.3)
  })
})

describe('NominatimGeocodingProvider', () => {
  it('resolves "Fukui Station" out of a recorded OpenStreetMap reply', async () => {
    const { result, calls } = await search(fukuiStation, 'Fukui Station')
    const best = result.matches[0]

    expect(best?.name).toBe('福井駅')
    expect(best?.at.latitude).toBeCloseTo(36.0621411, 6)
    expect(best?.at.longitude).toBeCloseTo(136.2221908, 6)
    expect(best?.kind).toBe('station')
    expect(best?.countryCode).toBe('jp')
    expect(best?.displayName).toContain('福井市')
    expect(best?.provenance.mode).toBe('live')
    expect(best?.provenance.attribution).toBe('© OpenStreetMap contributors')
    expect(calls[0]?.query).toBe('Fukui Station')
  })

  it('reorders a bounding box from Nominatim\'s lat-first form into a BBox', async () => {
    const { result } = await search(fukuiStation, 'Fukui Station')
    expect(result.matches[0]?.bbox).toEqual([136.2171908, 36.0571411, 136.2271908, 36.0671411])
  })

  it('leaves three equally prominent Springfields equally confident, so the caller must ask', async () => {
    const { result } = await search(springfield, 'Springfield')

    expect(result.matches.length).toBe(5)
    expect(result.matches.every((m) => m.kind === 'area')).toBe(true)
    const [first, second] = result.matches
    expect(first!.confidence - second!.confidence).toBeLessThan(0.1)
  })

  it('reports no match as coverage with a remedy, never as a failure', async () => {
    const { result } = await search(noMatch, 'zzzqqxnonexistentplace')

    expect(result.matches).toEqual([])
    expect(result.coverage.state).toBe('none')
    expect(result.coverage.detail).toContain('zzzqqxnonexistentplace')
  })

  it('refuses coordinates pasted into the name field rather than resolving them to something near', async () => {
    const { fetchImpl } = stubProxy(fukuiStation)
    const failure = await Effect.runPromise(
      Effect.either(new NominatimGeocodingProvider(fetchImpl).search({ text: '36.0621, 136.2222' })),
    )

    expect(failure._tag).toBe('Left')
    if (failure._tag === 'Left') {
      expect(failure.left._tag).toBe('GeocodeQueryInvalid')
    }
  })

  it('refuses an empty query without calling upstream', async () => {
    const { calls, fetchImpl } = stubProxy(fukuiStation)
    const failure = await Effect.runPromise(
      Effect.either(new NominatimGeocodingProvider(fetchImpl).search({ text: '   ' })),
    )

    expect(failure._tag).toBe('Left')
    expect(calls).toEqual([])
  })

  it('falls back to the gazetteer when the server says it served fixtures', async () => {
    const { result } = await search(
      { ok: true, mode: 'fixture', sourceId: 'global.osm.nominatim', data: null },
      'Fukui Station',
    )

    expect(result.matches[0]?.provenance.mode).toBe('fixture')
    expect(result.matches[0]?.name).toBe('福井駅')
  })

  it('treats a body that is not the documented array as no matches, not as a crash', async () => {
    const { result } = await search({ error: 'Unable to geocode' }, 'Fukui Station')
    expect(result.matches).toEqual([])
    expect(result.coverage.state).toBe('none')
  })

  it('surfaces an upstream failure as a typed source error', async () => {
    const { fetchImpl } = stubProxy('Bad Gateway', 502)
    const failure = await Effect.runPromise(
      Effect.either(new NominatimGeocodingProvider(fetchImpl).search({ text: 'Fukui Station' })),
    )

    expect(failure._tag).toBe('Left')
    if (failure._tag === 'Left') {
      expect(failure.left._tag).toBe('SourceUnavailable')
    }
  })
})
