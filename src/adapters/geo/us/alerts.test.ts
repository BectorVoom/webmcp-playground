import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { NWS_ALERTS_URL, UsAlertsProvider } from './alerts'
import houston from '../../../../fixtures/geo/us/alerts/upstream/nws-houston.json'
import washingtonDc from '../../../../fixtures/geo/us/alerts/upstream/nws-washington-dc.json'

const HOUSTON = { latitude: 29.7604, longitude: -95.3698 }
const WASHINGTON_DC = { latitude: 38.8951, longitude: -77.0364 }

const stubProxy = (body: unknown, status = 200) => {
  const calls: Array<Record<string, unknown>> = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('UsAlertsProvider (live NWS)', () => {
  /**
   * The recorded Houston alert expires on 31 August 2026, and the provider
   * drops anything already expired, so the feed is read at a time when it was
   * in force. A fixture is a recording of a moment; reading it against the wall
   * clock makes the suite fail on a date rather than on a defect.
   *
   * Only `Date` is faked: the Effect runtime schedules on real timers.
   */
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-29T21:00:00Z'))
  })
  afterAll(() => vi.useRealTimers())

  it('lets NWS do the spatial work with a point query', async () => {
    const { calls, fetchImpl } = stubProxy(houston)
    await Effect.runPromise(new UsAlertsProvider(fetchImpl).alertsFor({ at: HOUSTON, radiusKm: 20 }))

    expect(calls[0]?.upstreamUrl).toBe(
      'https://api.weather.gov/alerts/active?point=29.7604,-95.3698',
    )
    expect(NWS_ALERTS_URL(HOUSTON)).toBe(calls[0]?.upstreamUrl)
  })

  it('reads an alert out of a real NWS payload', async () => {
    const { fetchImpl } = stubProxy(houston)
    const res = await Effect.runPromise(
      new UsAlertsProvider(fetchImpl).alertsFor({ at: HOUSTON, radiusKm: 20 }),
    )

    expect(res.alerts).toHaveLength(1)
    expect(res.alerts[0]?.event).toBe('Air Quality Alert')
    expect(res.alerts[0]?.sender).toBe('NWS Houston/Galveston TX')
    expect(res.alerts[0]?.areaDescription).toContain('Inland Harris')
    expect(res.alerts[0]?.language).toBe('en')
    expect(res.alerts[0]?.provenance.mode).toBe('live')
  })

  it('maps CAP severity vocabulary, and does not guess at Unknown', async () => {
    const { fetchImpl } = stubProxy(houston)
    const res = await Effect.runPromise(
      new UsAlertsProvider(fetchImpl).alertsFor({ at: HOUSTON, radiusKm: 20 }),
    )

    // The recorded alert really is Unknown/Unknown/Unknown; inventing 'moderate' would be worse.
    expect(res.alerts[0]?.severity).toBe('unknown')
    expect(res.alerts[0]?.urgency).toBe('unknown')
    expect(res.alerts[0]?.certainty).toBe('unknown')
  })

  it('reports an empty feed as nothing in force, not as missing coverage', async () => {
    const { fetchImpl } = stubProxy(washingtonDc)
    const res = await Effect.runPromise(
      new UsAlertsProvider(fetchImpl).alertsFor({ at: WASHINGTON_DC, radiusKm: 20 }),
    )

    expect(res.alerts).toEqual([])
    expect(res.coverage.state).toBe('full')
    expect(res.coverage.reason).toBeUndefined()
  })

  it('never renders a test or exercise message as a real alert', async () => {
    const payload = {
      features: [
        {
          properties: {
            id: 'test-1',
            event: 'Tornado Warning',
            status: 'Test',
            messageType: 'Alert',
            severity: 'Extreme',
            expires: '2099-01-01T00:00:00Z',
          },
        },
        {
          properties: {
            id: 'real-1',
            event: 'Flood Warning',
            status: 'Actual',
            messageType: 'Alert',
            severity: 'Severe',
            expires: '2099-01-01T00:00:00Z',
          },
        },
      ],
    }
    const { fetchImpl } = stubProxy(payload)
    const res = await Effect.runPromise(
      new UsAlertsProvider(fetchImpl).alertsFor({ at: HOUSTON, radiusKm: 20 }),
    )

    expect(res.alerts.map((a) => a.id)).toEqual(['real-1'])
    expect(res.coverage.detail).toContain('non-actual')
  })

  it('drops cancellations and expired alerts', async () => {
    const payload = {
      features: [
        {
          properties: {
            id: 'cancelled',
            event: 'Flood Warning',
            status: 'Actual',
            messageType: 'Cancel',
            expires: '2099-01-01T00:00:00Z',
          },
        },
        {
          properties: {
            id: 'expired',
            event: 'Flood Warning',
            status: 'Actual',
            messageType: 'Alert',
            expires: '2020-01-01T00:00:00Z',
          },
        },
      ],
    }
    const { fetchImpl } = stubProxy(payload)
    const res = await Effect.runPromise(
      new UsAlertsProvider(fetchImpl).alertsFor({ at: HOUSTON, radiusKm: 20 }),
    )

    expect(res.alerts).toEqual([])
    expect(res.expiredCount).toBe(1)
  })

  it('orders the most severe first so the cap cannot drop it', async () => {
    const feature = (id: string, severity: string) => ({
      properties: {
        id,
        event: `${severity} event`,
        status: 'Actual',
        messageType: 'Alert',
        severity,
        expires: '2099-01-01T00:00:00Z',
      },
    })
    const { fetchImpl } = stubProxy({
      features: [feature('minor', 'Minor'), feature('extreme', 'Extreme'), feature('mod', 'Moderate')],
    })
    const res = await Effect.runPromise(
      new UsAlertsProvider(fetchImpl).alertsFor({ at: HOUSTON, radiusKm: 20, limit: 1 }),
    )

    expect(res.alerts.map((a) => a.id)).toEqual(['extreme'])
    expect(res.coverage.reason).toBe('result_cap')
  })

  it('reports a source failure instead of falling back to the DC fixture', async () => {
    const { fetchImpl } = stubProxy('upstream exploded', 502)
    const exit = await Effect.runPromiseExit(
      new UsAlertsProvider(fetchImpl).alertsFor({ at: HOUSTON, radiusKm: 20 }),
    )

    expect(exit._tag).toBe('Failure')
  })
})
