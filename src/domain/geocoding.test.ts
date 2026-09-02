import { describe, expect, it } from 'vitest'
import {
  describeConfidence,
  isAmbiguous,
  MIN_NAME_MATCH_SCORE,
  normalisePlaceQuery,
  scoreNameMatch,
  type GeocodedPlace,
} from './geocoding'
import type { Provenance } from './provenance'

const provenance: Provenance = {
  sourceId: 'test',
  sourceName: 'test',
  upstreamUrl: 'https://example.test',
  retrievedAt: 0,
  cache: { hit: false, ageMs: 0 },
  licence: 'test',
  attribution: 'test',
  mode: 'fixture',
}

const place = (name: string, confidence: number): GeocodedPlace => ({
  id: name,
  name,
  displayName: name,
  at: { latitude: 0, longitude: 0 },
  kind: 'poi',
  confidence,
  provenance,
})

describe('normalisePlaceQuery', () => {
  it('folds the differences that never distinguish two place names', () => {
    expect(normalisePlaceQuery('  Fukui   Station ')).toBe('fukui station')
    expect(normalisePlaceQuery('FUKUI STATION')).toBe('fukui station')
    // Full-width latin and the ideographic space both come out of Japanese input methods.
    expect(normalisePlaceQuery('Ｆｕｋｕｉ　Ｓｔａｔｉｏｎ')).toBe('fukui station')
    expect(normalisePlaceQuery('福井駅、中央1丁目')).toBe('福井駅 中央1丁目')
  })

  it('leaves an empty query empty rather than inventing one', () => {
    expect(normalisePlaceQuery('   ')).toBe('')
  })
})

describe('scoreNameMatch', () => {
  it('scores an exact name, however it was typed, as certain', () => {
    expect(scoreNameMatch('Fukui Station', 'Fukui Station')).toBe(1)
    expect(scoreNameMatch('fukui  station', 'Fukui Station')).toBe(1)
    expect(scoreNameMatch('福井駅', '福井駅')).toBe(1)
  })

  it('scores a prefix above containment above token overlap', () => {
    const prefix = scoreNameMatch('Fukui Station', 'Fukui Station (JR West)')
    const contained = scoreNameMatch('Station', 'Fukui Station East')
    const overlap = scoreNameMatch('Station Fukui', 'Fukui Station East Exit Plaza')
    expect(prefix).toBeGreaterThan(contained)
    expect(contained).toBeGreaterThan(overlap)
    expect(overlap).toBeGreaterThan(0)
  })

  it('finds a Japanese name inside its own address, which has no spaces to split on', () => {
    expect(scoreNameMatch('福井駅', '福井駅, 中央1丁目, 福井市')).toBeGreaterThanOrEqual(
      MIN_NAME_MATCH_SCORE,
    )
  })

  it('scores unrelated names at zero rather than weakly', () => {
    expect(scoreNameMatch('Fukui Station', 'Berlin Hauptbahnhof')).toBe(0)
    expect(scoreNameMatch('', 'Fukui Station')).toBe(0)
    expect(scoreNameMatch('Fukui Station', '')).toBe(0)
  })
})

describe('describeConfidence', () => {
  it('names the bands the summary prints', () => {
    expect(describeConfidence(0.95)).toBe('high')
    expect(describeConfidence(0.6)).toBe('moderate')
    expect(describeConfidence(0.3)).toBe('low')
  })
})

describe('isAmbiguous', () => {
  it('is ambiguous when the runner-up answers the name about as well', () => {
    expect(isAmbiguous([place('Springfield IL', 0.9), place('Springfield MO', 0.87)])).toBe(true)
  })

  it('is not ambiguous with a clear winner, or with nothing to compare against', () => {
    expect(isAmbiguous([place('Fukui Station', 0.95), place('Fukui City', 0.4)])).toBe(false)
    expect(isAmbiguous([place('Fukui Station', 0.95)])).toBe(false)
    expect(isAmbiguous([])).toBe(false)
  })
})
