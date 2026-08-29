import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Effect } from 'effect'
import { resolveRegion } from './region'
import { BrowserGeolocationAdapter } from './browser-geolocation'
import type { ResolvedLocation } from '../../domain/geo'

describe('region resolution (R6.2, R6.3)', () => {
  it('resolves Tokyo to jp region', () => {
    const res = Effect.runSync(resolveRegion({ latitude: 35.6812, longitude: 139.7671 }))
    expect(res.region).toBe('jp')
    expect(res.rule.authority).toContain('JMA')
  })

  it('resolves New York to us region', () => {
    const res = Effect.runSync(resolveRegion({ latitude: 40.7128, longitude: -74.006 }))
    expect(res.region).toBe('us')
    expect(res.rule.authority).toContain('NWS')
  })

  it('resolves London to eu region', () => {
    const res = Effect.runSync(resolveRegion({ latitude: 51.5074, longitude: -0.1278 }))
    expect(res.region).toBe('eu')
    expect(res.rule.authority).toContain('National civil protection')
  })

  it('fails for Seoul with RegionUnsupported without nearest-region fallback (Checkpoint 2)', () => {
    const seoul = { latitude: 37.5665, longitude: 126.978 }
    const error = Effect.runSync(Effect.flip(resolveRegion(seoul)))
    expect(error._tag).toBe('RegionUnsupported')
    expect(error.coordinates).toEqual(seoul)
    expect(error.supportedRegions).toEqual(['us', 'eu', 'jp'])
  })

  it('fails for Sydney with RegionUnsupported', () => {
    const sydney = { latitude: -33.8688, longitude: 151.2093 }
    const error = Effect.runSync(Effect.flip(resolveRegion(sydney)))
    expect(error._tag).toBe('RegionUnsupported')
  })
})

describe('geolocation adapter (R1.1–R1.5, R1.8)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('honours pinned location override (R1.4)', async () => {
    const adapter = new BrowserGeolocationAdapter()
    const pinned: ResolvedLocation = {
      coordinates: { latitude: 35.6895, longitude: 139.6917 },
      accuracyMetres: 10,
      source: 'pinned',
      resolvedAt: Date.now(),
    }
    adapter.setPinnedPosition(pinned)
    expect(adapter.getPinnedPosition()).toEqual(pinned)

    const result = await Effect.runPromise(adapter.getCurrentPosition())
    expect(result).toEqual(pinned)
    expect(result.source).toBe('pinned')
  })

  it('rejects insecure context (R1.8)', async () => {
    const adapter = new BrowserGeolocationAdapter({ isSecureContext: false })
    const error = await Effect.runPromise(Effect.flip(adapter.getCurrentPosition()))
    expect(error._tag).toBe('InsecureContext')
  })

  it('resolves geolocation via navigator and caches within TTL (R1.1, R1.5)', async () => {
    const mockGeolocation = {
      getCurrentPosition: vi.fn((success) => {
        success({
          coords: {
            latitude: 35.68,
            longitude: 139.76,
            accuracy: 25,
          },
        })
      }),
    }
    vi.stubGlobal('navigator', { geolocation: mockGeolocation })

    const adapter = new BrowserGeolocationAdapter({ isSecureContext: true, defaultTtlMs: 60_000 })
    const pos1 = await Effect.runPromise(adapter.getCurrentPosition())

    expect(pos1.coordinates).toEqual({ latitude: 35.68, longitude: 139.76 })
    expect(pos1.accuracyMetres).toBe(25)
    expect(pos1.source).toBe('geolocation')
    expect(mockGeolocation.getCurrentPosition).toHaveBeenCalledTimes(1)

    // Second call should hit TTL cache
    const pos2 = await Effect.runPromise(adapter.getCurrentPosition())
    expect(pos2).toEqual(pos1)
    expect(mockGeolocation.getCurrentPosition).toHaveBeenCalledTimes(1)
  })

  it('maps geolocation error codes to distinct tagged errors (R1.2)', async () => {
    // Permission denied (code 1)
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: vi.fn((_, error) => error({ code: 1, message: 'User denied' })),
      },
    })
    const adapter1 = new BrowserGeolocationAdapter({ isSecureContext: true })
    const err1 = await Effect.runPromise(Effect.flip(adapter1.getCurrentPosition()))
    expect(err1._tag).toBe('GeolocationDenied')

    // Position unavailable (code 2)
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: vi.fn((_, error) => error({ code: 2, message: 'Unavailable' })),
      },
    })
    const adapter2 = new BrowserGeolocationAdapter({ isSecureContext: true })
    const err2 = await Effect.runPromise(Effect.flip(adapter2.getCurrentPosition()))
    expect(err2._tag).toBe('GeolocationUnavailable')

    // Timeout (code 3)
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: vi.fn((_, error) => error({ code: 3, message: 'Timed out' })),
      },
    })
    const adapter3 = new BrowserGeolocationAdapter({ isSecureContext: true })
    const err3 = await Effect.runPromise(Effect.flip(adapter3.getCurrentPosition()))
    expect(err3._tag).toBe('GeolocationTimeout')
  })
})
