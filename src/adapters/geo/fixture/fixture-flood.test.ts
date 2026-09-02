import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { FixtureFloodProvider } from './fixture-flood'

/**
 * Fixture mode is the shipped default (`GEO_DATA_MODE=fixture`), so whatever this provider does is
 * what someone sees when they clone the repository and ask a question. It answered every query
 * outside Tokyo with an empty map — including Fukui, the location this project's docs, tests and
 * gazetteer all use — so the demo's own reference scenario drew nothing at all.
 */

const FUKUI_STATION = { latitude: 36.0621, longitude: 136.2222 }
const TOKYO = { latitude: 35.6812, longitude: 139.7671 }
const SEA_OF_JAPAN = { latitude: 37.6, longitude: 134.5 }

const query = (at: { latitude: number; longitude: number }, radiusKm = 20) =>
  Effect.runPromise(new FixtureFloodProvider('jp').zonesWithin({ at, radiusKm }))

describe('FixtureFloodProvider (jp)', () => {
  it('has recorded flood zones at Fukui Station', async () => {
    const res = await query(FUKUI_STATION)

    expect(res.zones.length).toBeGreaterThan(0)
    expect(res.coverage.state).toBe('full')
  })

  it('carries the depth bands the real hazard map shows there', async () => {
    const res = await query(FUKUI_STATION)
    const classes = new Set(res.zones.map((z) => z.hazardClass))

    expect(classes).toContain('low')
    expect(classes).toContain('moderate')
    expect(classes).toContain('high')
    expect(classes).toContain('extreme')
  })

  it('still covers Tokyo, which the conformance suite queries', async () => {
    const res = await query(TOKYO)
    expect(res.zones.length).toBeGreaterThan(0)
  })

  it('does not hand a Fukui query the zones recorded 300 km away in Tokyo', async () => {
    const res = await query(FUKUI_STATION)

    for (const zone of res.zones) {
      const [lon, lat] = zone.geometry.coordinates[0]?.[0] as [number, number]
      expect(Math.abs(lon - FUKUI_STATION.longitude)).toBeLessThan(1)
      expect(Math.abs(lat - FUKUI_STATION.latitude)).toBeLessThan(1)
    }
  })

  it('labels everything it serves as simulated, however real the geometry is', async () => {
    const res = await query(FUKUI_STATION)
    expect(res.zones.every((z) => z.provenance.mode === 'fixture')).toBe(true)
  })

  it('reports no coverage — and how to get some — where nothing was recorded', async () => {
    const res = await query(SEA_OF_JAPAN)

    expect(res.zones).toEqual([])
    expect(res.coverage.state).toBe('none')
    expect(res.coverage.detail).toContain('GEO_DATA_MODE=live')
  })

  it('never invents a zone centred on the query point', async () => {
    // The failure this provider is written against: a synthesised polygon under the user's feet
    // told everyone in Japan they stood in a 3–5 m inundation zone.
    const res = await query(SEA_OF_JAPAN, 1)
    expect(res.zones).toHaveLength(0)
  })
})
