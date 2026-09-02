import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { EuFloodForecastProvider } from './flood'
import ready from '../../../../fixtures/geo/eu/flood/upstream/cems-forecast-ready.json'

const query = { at: { latitude: 51.5074, longitude: -0.1278 }, radiusKm: 20 }

const stubFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

const run = (fetchImpl: typeof fetch) =>
  Effect.runPromise(new EuFloodForecastProvider(fetchImpl).zonesWithin(query))

describe('EuFloodForecastProvider', () => {
  it('passes through the zones and coverage of a ready forecast', async () => {
    const result = await run(stubFetch(ready))

    expect(result.zones).toHaveLength(1)
    expect(result.zones[0]!.hazardClass).toBe('high')
    expect(result.zones[0]!.kind.kind).toBe('forecast')
    expect(result.zones[0]!.provenance.attribution).toContain('GloFAS')
    expect(result.coverage.state).toBe('partial')
  })

  it('asks about the location and radius it was given', async () => {
    const seen: Array<string> = []
    const spy = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(init?.body))
      return new Response(JSON.stringify(ready), { status: 200 })
    }) as unknown as typeof fetch

    await run(spy)
    expect(JSON.parse(seen[0]!)).toEqual({
      at: { latitude: 51.5074, longitude: -0.1278 },
      radiusKm: 20,
    })
  })

  /**
   * The behaviour this provider exists for. A retrieval still in the queue returns no zones, and
   * an empty zone list on its own reads as "nothing here will flood" — so the reason travels with
   * it, and the answer explicitly denies being a finding of safety.
   */
  it('reports a queued retrieval as a coverage gap, not an empty map', async () => {
    const result = await run(
      stubFetch({ state: 'pending', detail: 'retrieving the current GloFAS forecast run' }, 202),
    )

    expect(result.zones).toEqual([])
    expect(result.coverage.state).toBe('none')
    expect(result.coverage.detail).toContain('retrieving the current GloFAS forecast run')
    expect(result.coverage.detail).toContain('not a finding that the area within 20 km is safe')
    // Queued work is not a failed source; nothing is broken.
    expect(result.coverage.failedSources).toEqual([])
  })

  it('reports an unconfigured token the same honest way', async () => {
    const result = await run(
      stubFetch({ state: 'unconfigured', detail: 'No Copernicus data-store token is configured.' }, 200),
    )

    expect(result.zones).toEqual([])
    expect(result.coverage.state).toBe('none')
    expect(result.coverage.detail).toContain('token is configured')
  })

  it('records a failed retrieval against the source', async () => {
    const result = await run(
      stubFetch({ state: 'failed', detail: 'The Copernicus account has not accepted the licences' }, 200),
    )

    expect(result.coverage.reason).toBe('source_failed')
    expect(result.coverage.failedSources[0]?.sourceId).toBe('eu.copernicus.glofas-forecast')
    expect(result.coverage.failedSources[0]?.error).toContain('licences')
  })

  /** A 202 is the normal answer while a job is queued; a 500 is this server actually broken. */
  it('fails on a server error rather than reporting no flooding', async () => {
    await expect(run(stubFetch({ error: 'Unhandled' }, 500))).rejects.toThrow(/HTTP 500/)
  })

  it('fails on a body that is not JSON', async () => {
    const html = (async () => new Response('<html>gateway</html>', { status: 200 })) as unknown as typeof fetch
    await expect(run(html)).rejects.toThrow(/not JSON/)
  })

  it('carries the licence and attribution Copernicus requires', () => {
    const meta = new EuFloodForecastProvider().meta
    expect(meta.attribution).toContain('Copernicus')
    expect(meta.licence).toContain('attribution')
    expect(meta.sourceId).toBe('eu.copernicus.glofas-forecast')
  })
})
