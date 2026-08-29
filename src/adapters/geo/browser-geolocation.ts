import { Effect } from 'effect'
import type { ResolvedLocation } from '../../domain/geo'
import {
  GeolocationDenied,
  GeolocationTimeout,
  GeolocationUnavailable,
  InsecureContext,
  type GeoError,
} from '../../domain/geo-errors'
import type { GeolocationOptions, GeolocationPort } from '../../ports/Geolocation'

export interface BrowserGeolocationConfig {
  readonly defaultTtlMs?: number
  readonly isSecureContext?: boolean
}

export class BrowserGeolocationAdapter implements GeolocationPort {
  private pinnedLocation: ResolvedLocation | null = null
  private cachedLocation: { location: ResolvedLocation; expiresAt: number } | null = null
  private readonly defaultTtlMs: number
  private readonly isSecure: boolean

  constructor(config: BrowserGeolocationConfig = {}) {
    this.defaultTtlMs = config.defaultTtlMs ?? 60_000
    this.isSecure =
      config.isSecureContext ??
      (typeof window !== 'undefined' ? window.isSecureContext !== false : true)
  }

  setPinnedPosition(location: ResolvedLocation | null): void {
    this.pinnedLocation = location
  }

  getPinnedPosition(): ResolvedLocation | null {
    return this.pinnedLocation
  }

  getCurrentPosition(
    options: GeolocationOptions = {},
  ): Effect.Effect<ResolvedLocation, GeoError> {
    return Effect.gen(this, function* () {
      // 1. Pinned position override (R1.4)
      if (this.pinnedLocation !== null) {
        return this.pinnedLocation
      }

      // 2. Insecure context check (R1.8)
      if (!this.isSecure) {
        const origin = typeof window !== 'undefined' ? window.location?.origin ?? 'unknown' : 'insecure'
        return yield* Effect.fail(new InsecureContext({ origin }))
      }

      // 3. TTL Cache (R1.5)
      const now = Date.now()
      if (this.cachedLocation && this.cachedLocation.expiresAt > now) {
        return this.cachedLocation.location
      }

      // 4. Browser HTML5 Geolocation API (R1.1, R1.2)
      const timeoutMs = options.timeoutMs ?? 10_000
      const maximumAge = options.maximumAgeMs ?? this.defaultTtlMs

      const resolved = yield* Effect.async<ResolvedLocation, GeoError>((resume) => {
        if (typeof navigator === 'undefined' || !navigator.geolocation) {
          resume(
            Effect.fail(
              new GeolocationUnavailable({
                message: 'HTML5 Geolocation API is not supported in this environment',
              }),
            ),
          )
          return
        }

        let settled = false

        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            if (!settled) {
              settled = true
              resume(
                Effect.fail(
                  new GeolocationTimeout({
                    timeoutMs: 0,
                  }),
                ),
              )
            }
          })
        }

        navigator.geolocation.getCurrentPosition(
          (pos) => {
            if (settled) return
            settled = true
            const location: ResolvedLocation = {
              coordinates: {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
              },
              accuracyMetres: pos.coords.accuracy,
              source: 'geolocation',
              resolvedAt: Date.now(),
            }
            resume(Effect.succeed(location))
          },
          (err) => {
            if (settled) return
            settled = true
            switch (err.code) {
              case 1: // PERMISSION_DENIED
                resume(Effect.fail(new GeolocationDenied({ message: err.message })))
                break
              case 3: // TIMEOUT
                resume(Effect.fail(new GeolocationTimeout({ timeoutMs })))
                break
              case 2: // POSITION_UNAVAILABLE
              default:
                resume(
                  Effect.fail(
                    new GeolocationUnavailable({ message: err.message || 'Position unavailable' }),
                  ),
                )
                break
            }
          },
          {
            enableHighAccuracy: true,
            timeout: timeoutMs,
            maximumAge,
          },
        )
      })

      // Update cache
      this.cachedLocation = {
        location: resolved,
        expiresAt: Date.now() + this.defaultTtlMs,
      }

      return resolved
    })
  }
}
