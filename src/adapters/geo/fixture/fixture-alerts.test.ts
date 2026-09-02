import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { FixtureAlertsProvider } from './fixture-alerts'
import type { AlertsQuery } from '../../../ports/Alerts'

const TOKYO = { latitude: 35.6812, longitude: 139.7671 } // 東京駅 — inside 東京都 23区
const FUKUI = { latitude: 36.0619, longitude: 136.2233 } // 福井駅 — ~300 km from Tokyo
const WASHINGTON_DC = { latitude: 38.8951, longitude: -77.0364 }
const LONDON = { latitude: 51.5074, longitude: -0.1278 }

const ask = (provider: FixtureAlertsProvider, query: AlertsQuery) =>
  Effect.runSync(provider.alertsFor(query))

describe('FixtureAlertsProvider spatial filtering', () => {
  it('returns the Tokyo warnings for a location inside the issued area', () => {
    const res = ask(new FixtureAlertsProvider('jp'), { at: TOKYO, radiusKm: 20 })

    expect(res.alerts.map((a) => a.event)).toEqual(['大雨警報（浸水害）', '洪水警報'])
    expect(res.totalActiveCount).toBe(2)
    expect(res.coverage.state).toBe('full')
  })

  it('does not report Tokyo warnings to a user in Fukui', () => {
    const res = ask(new FixtureAlertsProvider('jp'), { at: FUKUI, radiusKm: 20 })

    expect(res.alerts).toEqual([])
    expect(res.totalActiveCount).toBe(0)
  })

  it('distinguishes "no data for your area" from "nothing in force"', () => {
    const res = ask(new FixtureAlertsProvider('jp'), { at: FUKUI, radiusKm: 20 })

    expect(res.coverage.state).toBe('none')
    expect(res.coverage.reason).toBe('no_data_for_area')
    expect(res.coverage.detail).toContain('東京都 23区')
  })

  it('includes an alert whose area the query radius reaches but does not contain', () => {
    // ~35 km due north of the 東京都 23区 box, which ends at 35.82.
    const northOfTokyo = { latitude: 36.14, longitude: 139.7671 }

    expect(ask(new FixtureAlertsProvider('jp'), { at: northOfTokyo, radiusKm: 5 }).alerts).toEqual([])
    expect(
      ask(new FixtureAlertsProvider('jp'), { at: northOfTokyo, radiusKm: 40 }).alerts,
    ).toHaveLength(2)
  })

  it('filters by area in every region, not just Japan', () => {
    const us = new FixtureAlertsProvider('us')
    expect(ask(us, { at: WASHINGTON_DC, radiusKm: 20 }).alerts).toHaveLength(1)
    expect(ask(us, { at: LONDON, radiusKm: 20 }).alerts).toEqual([])

    const eu = new FixtureAlertsProvider('eu')
    expect(ask(eu, { at: LONDON, radiusKm: 20 }).alerts).toHaveLength(1)
    expect(ask(eu, { at: WASHINGTON_DC, radiusKm: 20 }).alerts).toEqual([])
  })

  it('caps results without claiming full coverage', () => {
    const res = ask(new FixtureAlertsProvider('jp'), { at: TOKYO, radiusKm: 20, limit: 1 })

    expect(res.alerts).toHaveLength(1)
    expect(res.totalActiveCount).toBe(2)
    expect(res.coverage.state).toBe('partial')
    expect(res.coverage.reason).toBe('result_cap')
  })
})
