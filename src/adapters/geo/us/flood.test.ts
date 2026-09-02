import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { NFHL_QUERY_URL, UsFloodScenarioProvider } from './flood'

const HOUSTON = { latitude: 29.7604, longitude: -95.3698 }

const square = (): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [-95.38, 29.75],
      [-95.36, 29.75],
      [-95.36, 29.77],
      [-95.38, 29.77],
      [-95.38, 29.75],
    ],
  ],
})

const payloadOf = (
  properties: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> => ({
  type: 'FeatureCollection',
  features: properties.map((p, i) => ({ id: i, properties: p, geometry: square() })),
})

const stub = (body: unknown, status = 200) => {
  const calls: Array<Record<string, unknown>> = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { calls, provider: new UsFloodScenarioProvider(fetchImpl) }
}

describe('UsFloodScenarioProvider (FEMA NFHL)', () => {
  it('queries the NFHL flood hazard layer over the query envelope', async () => {
    const { calls, provider } = stub(payloadOf([]))
    await Effect.runPromise(provider.zonesWithin({ at: HOUSTON, radiusKm: 10 }))

    const url = String(calls[0]?.upstreamUrl)
    expect(url).toContain('/NFHL/MapServer/28/query')
    expect(url).toContain('f=geojson')
    expect(url).toContain('esriGeometryEnvelope')
    expect(NFHL_QUERY_URL(HOUSTON, 10)).toBe(url)
  })

  it('maps FEMA zone letters onto hazard classes', async () => {
    const { provider } = stub(
      payloadOf([
        { FLD_ZONE: 'VE' },
        { FLD_ZONE: 'AE' },
        { FLD_ZONE: 'X', ZONE_SUBTY: '0.2 PCT ANNUAL CHANCE FLOOD HAZARD' },
        { FLD_ZONE: 'D' },
      ]),
    )
    const res = await Effect.runPromise(provider.zonesWithin({ at: HOUSTON, radiusKm: 10 }))

    expect(res.zones.map((z) => z.hazardClass)).toEqual([
      'extreme', // VE — coastal high hazard, waves on top of the 1% flood
      'high', // AE — 1% annual chance
      'moderate', // shaded X — 0.2% annual chance
      'unclassified', // D — undetermined, not "safe"
    ])
  })

  it('never draws unshaded Zone X or open water as a flood hazard', async () => {
    const { provider } = stub(
      payloadOf([
        { FLD_ZONE: 'X', ZONE_SUBTY: 'AREA OF MINIMAL FLOOD HAZARD' },
        { FLD_ZONE: 'OPEN WATER' },
        { FLD_ZONE: 'AREA NOT INCLUDED' },
      ]),
    )
    const res = await Effect.runPromise(provider.zonesWithin({ at: HOUSTON, radiusKm: 10 }))

    expect(res.zones).toEqual([])
    expect(res.coverage.detail).toContain('minimal risk')
  })

  it('reports a depth only for AO zones, never from a base flood elevation', async () => {
    const { provider } = stub(
      payloadOf([
        { FLD_ZONE: 'AO', DEPTH: 3 },
        // STATIC_BFE is height above datum. Reading it as depth would claim 12 m of water.
        { FLD_ZONE: 'AE', STATIC_BFE: 40 },
      ]),
    )
    const res = await Effect.runPromise(provider.zonesWithin({ at: HOUSTON, radiusKm: 10 }))

    expect(res.zones[0]?.depth).toEqual({ minMetres: 0, maxMetres: 0.9 })
    expect(res.zones[1]?.depth).toBeUndefined()
  })

  it('labels NFHL as a scenario map, never as a forecast', async () => {
    const { provider } = stub(payloadOf([{ FLD_ZONE: 'AE' }]))
    const res = await Effect.runPromise(provider.zonesWithin({ at: HOUSTON, radiusKm: 10 }))

    expect(res.zones[0]?.kind.kind).toBe('scenario')
    expect(res.zones[0]?.provenance.mode).toBe('live')
    expect(res.zones[0]?.provenance.sourceId).toBe('us.fema.nfhl')
  })

  it('says an empty result is missing mapping, not proof of safety', async () => {
    const { provider } = stub(payloadOf([]))
    const res = await Effect.runPromise(provider.zonesWithin({ at: HOUSTON, radiusKm: 10 }))

    expect(res.zones).toEqual([])
    expect(res.coverage.detail).toContain('not proof of safety')
  })

  it('reports a source failure rather than an empty map', async () => {
    const { provider } = stub('gateway timeout', 502)
    const exit = await Effect.runPromiseExit(provider.zonesWithin({ at: HOUSTON, radiusKm: 10 }))

    expect(exit._tag).toBe('Failure')
  })
})
