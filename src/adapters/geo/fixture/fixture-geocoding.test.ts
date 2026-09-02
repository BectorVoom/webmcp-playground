import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { FixtureGeocodingProvider } from './fixture-geocoding'

const search = (text: string, extra: { limit?: number; near?: { latitude: number; longitude: number } } = {}) =>
  Effect.runPromise(new FixtureGeocodingProvider().search({ text, ...extra }))

describe('FixtureGeocodingProvider', () => {
  it('resolves a station named in English to its real coordinates', async () => {
    const result = await search('Fukui Station')
    const best = result.matches[0]

    expect(best?.name).toBe('福井駅')
    expect(best?.kind).toBe('station')
    // The same node OpenStreetMap resolves this query to; the gazetteer and the live geocoder
    // must not disagree about where Fukui Station is.
    expect(best?.at.latitude).toBeCloseTo(36.0621, 4)
    expect(best?.at.longitude).toBeCloseTo(136.2222, 4)
    expect(result.coverage.state).toBe('full')
  })

  it('resolves the same station named in Japanese', async () => {
    const result = await search('福井駅')
    expect(result.matches[0]?.id).toBe('fixture-jp-fukui-station')
  })

  it('resolves an Aomori Station latitude request instead of requiring an exact bare name', async () => {
    const result = await search('Aomori station latitude')
    const best = result.matches[0]

    expect(best?.id).toBe('fixture-jp-aomori-station')
    expect(best?.name).toBe('青森駅')
    expect(best?.kind).toBe('station')
    expect(best?.at.latitude).toBeCloseTo(40.8289, 4)
    expect(best?.at.longitude).toBeCloseTo(140.7336, 4)
  })

  it('recognises both Tsugaru and the common Tugaru spelling as the same warning area', async () => {
    const tsugaru = await search('Tsugaru area')
    const tugaru = await search('Tugaru area')

    expect(tsugaru.matches[0]?.id).toBe('fixture-jp-tsugaru-area')
    expect(tugaru.matches[0]?.id).toBe('fixture-jp-tsugaru-area')
    expect(tugaru.matches[0]?.kind).toBe('area')
  })

  it('marks every match as simulated, since a gazetteer is not a geocoder', async () => {
    const result = await search('Fukui Station')
    expect(result.matches[0]?.provenance.mode).toBe('fixture')
  })

  it('ranks the exact name above the place that merely contains it', async () => {
    const result = await search('福井市')
    expect(result.matches[0]?.id).toBe('fixture-jp-fukui-city')
  })

  it('invents nothing for a name it does not hold, and says why', async () => {
    const result = await search('Nonexistent Village of Nowhere')

    expect(result.matches).toEqual([])
    expect(result.coverage.state).toBe('none')
    expect(result.coverage.detail).toContain('GEO_DATA_MODE=live')
    expect(result.coverage.detail).toContain('No coordinates were invented')
  })

  it('honours the result limit', async () => {
    const result = await search('Station', { limit: 2 })
    expect(result.matches.length).toBe(2)
  })

  it('breaks a tie towards the nearer place without letting distance outrank the name', async () => {
    const nearTokyo = await search('Station', { near: { latitude: 35.68, longitude: 139.76 }, limit: 1 })
    const nearBerlin = await search('Station', { near: { latitude: 52.52, longitude: 13.37 }, limit: 1 })

    // Both candidates score identically on the name, so the bias decides — and only then.
    expect(nearTokyo.matches[0]?.id).not.toBe(nearBerlin.matches[0]?.id)
    expect(nearBerlin.matches[0]?.countryCode).toBe('de')
  })
})
