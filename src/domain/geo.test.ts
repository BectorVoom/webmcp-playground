import { describe, expect, it } from 'vitest'
import {
  bearingToDirection,
  clampRadius,
  DEFAULT_RADIUS_KM,
  MAX_RADIUS_KM,
  MIN_RADIUS_KM,
  roundCoordsForOutbound,
  roundCoordsForTrace,
  roundToDp,
} from './geo'
import { calculateStaleness } from './provenance'
import type { FloodZone, ZoneKind } from './hazard'
import { describeGeoError, RegionUnsupported, remedyForGeoError } from './geo-errors'

describe('domain / geo', () => {
  describe('coordinate rounding (R1.6, R8.7)', () => {
    it('rounds to 4 decimal places for outbound queries', () => {
      const loc = { latitude: 35.6812345, longitude: 139.7671234 }
      const rounded = roundCoordsForOutbound(loc)
      expect(rounded.latitude).toBe(35.6812)
      expect(rounded.longitude).toBe(139.7671)
    })

    it('rounds to 3 decimal places for traces', () => {
      const loc = { latitude: 35.6812345, longitude: 139.7671234 }
      const rounded = roundCoordsForTrace(loc)
      expect(rounded.latitude).toBe(35.681)
      expect(rounded.longitude).toBe(139.767)
    })

    it('handles negative boundary coordinates correctly', () => {
      expect(roundToDp(-122.4194155, 4)).toBe(-122.4194)
      expect(roundToDp(-122.4194155, 3)).toBe(-122.419)
      expect(roundToDp(0.00001, 4)).toBe(0)
    })
  })

  describe('radius clamping (R1.9)', () => {
    it('defaults to 20 km when omitted', () => {
      const res = clampRadius(undefined)
      expect(res.radiusKm).toBe(DEFAULT_RADIUS_KM)
      expect(res.wasClamped).toBe(false)
    })

    it('clamps values below 1 km up to 1 km and marks wasClamped', () => {
      const res = clampRadius(0.5)
      expect(res.radiusKm).toBe(MIN_RADIUS_KM)
      expect(res.requestedKm).toBe(0.5)
      expect(res.wasClamped).toBe(true)
    })

    it('clamps values above 20 km down to 20 km and marks wasClamped', () => {
      const res = clampRadius(50)
      expect(res.radiusKm).toBe(MAX_RADIUS_KM)
      expect(res.requestedKm).toBe(50)
      expect(res.wasClamped).toBe(true)
    })

    it('leaves values within [1, 20] unclamped', () => {
      const res = clampRadius(10)
      expect(res.radiusKm).toBe(10)
      expect(res.wasClamped).toBe(false)
    })
  })

  describe('bearing to compass direction', () => {
    it('maps bearings correctly', () => {
      expect(bearingToDirection(0)).toBe('N')
      expect(bearingToDirection(360)).toBe('N')
      expect(bearingToDirection(90)).toBe('E')
      expect(bearingToDirection(180)).toBe('S')
      expect(bearingToDirection(270)).toBe('W')
      expect(bearingToDirection(45)).toBe('NE')
      expect(bearingToDirection(135)).toBe('SE')
      expect(bearingToDirection(225)).toBe('SW')
      expect(bearingToDirection(315)).toBe('NW')
    })
  })
})

describe('domain / provenance & staleness (R2.9)', () => {
  it('calculates staleness correctly when older than expected refresh', () => {
    const issuedAt = 1_000_000
    const refreshMs = 60_000
    const fresh = calculateStaleness(issuedAt, issuedAt + 30_000, refreshMs)
    expect(fresh.stale).toBe(false)
    expect(fresh.ageMs).toBe(30_000)

    const stale = calculateStaleness(issuedAt, issuedAt + 120_000, refreshMs)
    expect(stale.stale).toBe(true)
    expect(stale.ageMs).toBe(120_000)
    expect(stale.expectedRefreshMs).toBe(60_000)
  })

  it('handles missing issuedAt or refreshMs gracefully', () => {
    expect(calculateStaleness(undefined, 1000, 60000).stale).toBe(false)
    expect(calculateStaleness(1000, 2000, undefined).stale).toBe(false)
  })
})

describe('domain / hazard ZoneKind discrimination (R2.2, ADR-2)', () => {
  it('distinguishes forecast and scenario zone kinds at type and value level', () => {
    const forecastKind: ZoneKind = {
      kind: 'forecast',
      validFrom: 1700000000000,
      validTo: 1700086400000,
    }

    const scenarioKind: ZoneKind = {
      kind: 'scenario',
      designEvent: 'L2 assumed maximum inundation',
    }

    expect(forecastKind.kind).toBe('forecast')
    expect('validFrom' in forecastKind).toBe(true)
    expect('designEvent' in forecastKind).toBe(false)

    expect(scenarioKind.kind).toBe('scenario')
    expect('designEvent' in scenarioKind).toBe(true)
    expect('validFrom' in scenarioKind).toBe(false)

    const zone: FloodZone = {
      id: 'fz-1',
      kind: scenarioKind,
      hazardClass: 'high',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [139.7, 35.6],
            [139.8, 35.6],
            [139.8, 35.7],
            [139.7, 35.7],
            [139.7, 35.6],
          ],
        ],
      },
      provenance: {
        sourceId: 'jp.gsi.flood-l2',
        sourceName: 'GSI Hazard Map',
        upstreamUrl: 'https://cyberjapandata.gsi.go.jp/...',
        retrievedAt: Date.now(),
        cache: { hit: false, ageMs: 0 },
        licence: 'GSI Terms',
        attribution: '国土地理院',
        mode: 'fixture',
      },
    }

    expect(zone.kind.kind).toBe('scenario')
    if (zone.kind.kind === 'scenario') {
      expect(zone.kind.designEvent).toBe('L2 assumed maximum inundation')
    }
  })
})

describe('domain / geo errors (Design §11, R8.9)', () => {
  it('describes RegionUnsupported and provides actionable remedy', () => {
    const error = new RegionUnsupported({
      coordinates: { latitude: 37.5665, longitude: 126.978 },
      supportedRegions: ['us', 'eu', 'jp'],
    })

    const desc = describeGeoError(error)
    const remedy = remedyForGeoError(error)

    expect(desc).toContain('outside supported regions (us, eu, jp)')
    expect(desc).toContain('No provider was consulted')
    expect(remedy).toContain('Only us, eu, jp are currently covered')
  })
})
