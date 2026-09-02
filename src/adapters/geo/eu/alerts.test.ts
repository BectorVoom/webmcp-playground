import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { EuAlertsProvider, parseMeteoAlarmFeed } from './alerts'
import { METEOALARM_FEED_URL, resolveMeteoAlarmCountry } from './meteoalarm-countries'
import franceFeed from '../../../../fixtures/geo/eu/alerts/upstream/meteoalarm-france.atom.xml?raw'

const PARIS = { latitude: 48.8566, longitude: 2.3522 }
/** Inside the Somme `cap:polygon` the recorded feed carries, in the Channel off Picardy. */
const OFF_SOMME = { latitude: 50.29, longitude: 1.3644 }

const stubProxy = (body: string, status = 200) => {
  const calls: Array<Record<string, unknown>> = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response(body, { status })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('resolveMeteoAlarmCountry', () => {
  const CITIES: ReadonlyArray<readonly [string, number, number, string]> = [
    ['Paris', 2.3522, 48.8566, 'france'],
    ['London', -0.1278, 51.5074, 'united-kingdom'],
    ['Brussels', 4.3517, 50.8503, 'belgium'],
    ['Amsterdam', 4.9041, 52.3676, 'netherlands'],
    ['Berlin', 13.405, 52.52, 'germany'],
    ['Madrid', -3.7038, 40.4168, 'spain'],
    ['Lisbon', -9.1393, 38.7223, 'portugal'],
    ['Rome', 12.4964, 41.9028, 'italy'],
    ['Vienna', 16.3738, 48.2082, 'austria'],
    ['Zurich', 8.5417, 47.3769, 'switzerland'],
    ['Stockholm', 18.0686, 59.3293, 'sweden'],
    ['Oslo', 10.7522, 59.9139, 'norway'],
    ['Copenhagen', 12.5683, 55.6761, 'denmark'],
    ['Dublin', -6.2603, 53.3498, 'ireland'],
    ['Warsaw', 21.0122, 52.2297, 'poland'],
    ['Athens', 23.7275, 37.9838, 'greece'],
    ['Reykjavik', -21.9426, 64.1466, 'iceland'],
    ['Skopje', 21.4254, 41.9981, 'republic-of-north-macedonia'],
    ['Las Palmas (Canaries)', -15.4363, 28.1235, 'spain'],
    ['Ponta Delgada (Azores)', -25.6806, 37.7412, 'portugal'],
  ]

  it.each(CITIES)('resolves %s to the %s feed', (_name, longitude, latitude, slug) => {
    expect(resolveMeteoAlarmCountry({ longitude, latitude }).slug).toBe(slug)
  })
})

describe('parseMeteoAlarmFeed', () => {
  it('reads every entry out of a real MeteoAlarm Atom feed', () => {
    const entries = parseMeteoAlarmFeed(franceFeed)
    expect(entries).toHaveLength(29)
    expect(entries[0]?.areaDesc).toBe('Haute-Corse')
    expect(entries[0]?.event).toBe('Moderate high-temperature warning')
    expect(entries[0]?.severity).toBe('Moderate')
  })

  it('converts CAP lat,lon polygons into GeoJSON lon,lat rings', () => {
    const withGeometry = parseMeteoAlarmFeed(franceFeed).filter((e) => e.polygons.length > 0)
    expect(withGeometry).toHaveLength(3)

    const ring = withGeometry.find((e) => e.areaDesc === 'Somme')!.polygons[0]!.coordinates[0]!
    // CAP said "50.391,1.515" — latitude first. GeoJSON needs it the other way round.
    expect(ring[0]).toEqual([1.515, 50.391])
    // And the ring must close, or point-in-polygon silently answers false.
    expect(ring[0]).toEqual(ring[ring.length - 1])
  })

  it('returns nothing for a body that is not a feed', () => {
    expect(parseMeteoAlarmFeed('<html><body>502 Bad Gateway</body></html>')).toEqual([])
  })
})

describe('EuAlertsProvider (live MeteoAlarm)', () => {
  /**
   * The recorded feed is a moment, and the provider drops anything already
   * expired, so it has to be read at a time when it was live — its warnings ran
   * out on 29 and 30 August 2026. Without this the suite passes until that date
   * and then fails every day after, which is what it did.
   *
   * Only `Date` is faked: the Effect runtime schedules on real timers.
   */
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-29T15:00:00Z'))
  })
  afterAll(() => vi.useRealTimers())

  it("asks for the feed of the country the caller is in", async () => {
    const { calls, fetchImpl } = stubProxy(franceFeed)
    await Effect.runPromise(new EuAlertsProvider(fetchImpl).alertsFor({ at: PARIS, radiusKm: 20 }))

    expect(calls[0]?.upstreamUrl).toBe(METEOALARM_FEED_URL('france'))
  })

  it('drops a geometry-carrying warning that does not cover the caller', async () => {
    const { fetchImpl } = stubProxy(franceFeed)
    const res = await Effect.runPromise(
      new EuAlertsProvider(fetchImpl).alertsFor({ at: PARIS, radiusKm: 20, limit: 50 }),
    )

    // The three coastal warnings publish polygons in the Channel. Paris is in none of them.
    expect(res.alerts.filter((a) => a.event.includes('coastalevent'))).toEqual([])
  })

  it('keeps a geometry-carrying warning that does cover the caller, and ranks it first', async () => {
    const { fetchImpl } = stubProxy(franceFeed)
    const res = await Effect.runPromise(
      new EuAlertsProvider(fetchImpl).alertsFor({ at: OFF_SOMME, radiusKm: 20, limit: 50 }),
    )

    expect(res.alerts[0]?.areaDescription).toBe('France — Somme')
    expect(res.alerts[0]?.event).toBe('Moderate coastalevent warning')
  })

  it('keeps region-coded warnings but says they are not narrowed to the location', async () => {
    const { fetchImpl } = stubProxy(franceFeed)
    const res = await Effect.runPromise(
      new EuAlertsProvider(fetchImpl).alertsFor({ at: PARIS, radiusKm: 20, limit: 50 }),
    )

    expect(res.alerts.length).toBeGreaterThan(0)
    expect(res.coverage.state).toBe('partial')
    expect(res.coverage.detail).toContain('region name, not by geometry')
    expect(res.coverage.detail).toContain('France')
    // Each one still names its own region, so a reader can see it is elsewhere.
    expect(res.alerts.every((a) => a.areaDescription.startsWith('France'))).toBe(true)
  })

  it('carries MeteoAlarm provenance and marks the data live', async () => {
    const { fetchImpl } = stubProxy(franceFeed)
    const res = await Effect.runPromise(
      new EuAlertsProvider(fetchImpl).alertsFor({ at: PARIS, radiusKm: 20 }),
    )

    expect(res.alerts[0]?.provenance.mode).toBe('live')
    expect(res.alerts[0]?.provenance.sourceId).toBe('eu.meteoalarm.alerts')
    expect(res.alerts[0]?.provenance.upstreamUrl).toBe(METEOALARM_FEED_URL('france'))
  })

  it('fails rather than reading an unparseable body as "all clear"', async () => {
    const { fetchImpl } = stubProxy('<html><body>Bad Gateway</body></html>')
    const exit = await Effect.runPromiseExit(
      new EuAlertsProvider(fetchImpl).alertsFor({ at: PARIS, radiusKm: 20 }),
    )

    expect(exit._tag).toBe('Failure')
  })

  it('reports an empty but well-formed feed as nothing in force', async () => {
    const empty = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>MeteoAlarm</title></feed>`
    const { fetchImpl } = stubProxy(empty)
    const res = await Effect.runPromise(
      new EuAlertsProvider(fetchImpl).alertsFor({ at: PARIS, radiusKm: 20 }),
    )

    expect(res.alerts).toEqual([])
    expect(res.coverage.state).toBe('full')
  })
})
