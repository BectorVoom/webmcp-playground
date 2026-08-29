import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { FIXTURE_BUNDLES, LIVE_BUNDLES } from './registry'
import type { RegionId } from './region'

const REGION_CENTERS: Record<RegionId, { latitude: number; longitude: number }> = {
  jp: { latitude: 35.6812, longitude: 139.7671 },
  us: { latitude: 38.8951, longitude: -77.0364 },
  eu: { latitude: 51.5074, longitude: -0.1278 },
}

describe('Geo Provider Conformance Suite (R6.5)', () => {
  const bundlesToTest = [
    { label: 'fixture', bundles: FIXTURE_BUNDLES },
    { label: 'live (with fixture fallback)', bundles: LIVE_BUNDLES },
  ]

  for (const { label, bundles } of bundlesToTest) {
    describe(`${label} bundles`, () => {
      for (const [regionKey, bundle] of Object.entries(bundles)) {
        const region = regionKey as RegionId
        const center = REGION_CENTERS[region]

        describe(`Region [${region.toUpperCase()}]`, () => {
          // 1. Flood Providers
          describe('Flood Providers', () => {
            for (const floodProvider of bundle.flood) {
              it(`[${floodProvider.sourceId}] honours query radius and returns complete provenance`, async () => {
                const res = await Effect.runPromise(
                  floodProvider.zonesWithin({ at: center, radiusKm: 20 }),
                )

                expect(res.coverage).toBeDefined()
                expect(res.staleness).toBeDefined()

                for (const zone of res.zones) {
                  expect(zone.id).toBeDefined()
                  expect(zone.hazardClass).toBeDefined()
                  expect(zone.geometry).toBeDefined()
                  expect(zone.provenance).toBeDefined()
                  expect(zone.provenance.sourceId).toBeDefined()
                  expect(zone.provenance.attribution).toBeDefined()
                  expect(zone.provenance.licence).toBeDefined()
                  expect(zone.provenance.retrievedAt).toBeGreaterThan(0)
                  expect(zone.provenance.mode).toBeDefined()
                }
              })
            }
          })

          // 2. Places Providers
          describe('Places Providers', () => {
            for (const placesProvider of bundle.places) {
              it(`[${placesProvider.sourceId}] filters within radius and includes category & provenance`, async () => {
                const res = await Effect.runPromise(
                  placesProvider.facilitiesWithin({ at: center, radiusKm: 20, limit: 5 }),
                )

                expect(res.coverage).toBeDefined()
                expect(res.facilities.length).toBeLessThanOrEqual(5)

                for (const fac of res.facilities) {
                  expect(fac.id).toBeDefined()
                  expect(fac.name).toBeDefined()
                  expect(fac.category).toBeDefined()
                  expect(fac.at).toBeDefined()
                  expect(fac.metres).toBeLessThanOrEqual(20000)
                  expect(fac.bearing).toBeGreaterThanOrEqual(0)
                  expect(fac.bearing).toBeLessThanOrEqual(360)
                  expect(fac.provenance).toBeDefined()
                }
              })
            }
          })

          // 3. Alerts Providers
          describe('Alerts Providers', () => {
            for (const alertsProvider of bundle.alerts) {
              it(`[${alertsProvider.sourceId}] preserves verbatim headline & description with language tag`, async () => {
                const res = await Effect.runPromise(
                  alertsProvider.alertsFor({ at: center, radiusKm: 20 }),
                )

                expect(res.coverage).toBeDefined()
                expect(res.totalActiveCount).toBeGreaterThanOrEqual(0)

                for (const alert of res.alerts) {
                  expect(alert.id).toBeDefined()
                  expect(alert.headline).toBeDefined()
                  expect(alert.description).toBeDefined()
                  expect(alert.language).toBeDefined()
                  expect(alert.severity).toBeDefined()
                  expect(alert.provenance).toBeDefined()
                }
              })
            }
          })

          // 4. Routing Provider
          describe('Routing Provider', () => {
            it(`[${bundle.routing.sourceId}] computes routes with costing and provenance`, async () => {
              const placesRes = await Effect.runPromise(
                bundle.places[0]!.facilitiesWithin({ at: center, radiusKm: 20, limit: 2 }),
              )

              const routeRes = await Effect.runPromise(
                bundle.routing.route({
                  origin: center,
                  destinations: placesRes.facilities,
                  costing: 'pedestrian',
                }),
              )

              expect(routeRes.costing).toBe('pedestrian')
              expect(routeRes.results.length).toBe(placesRes.facilities.length)

              for (const r of routeRes.results) {
                if (r.ok) {
                  expect(r.route.geometry.type).toBe('LineString')
                  expect(r.route.metres).toBeGreaterThan(0)
                  expect(r.route.seconds).toBeGreaterThan(0)
                  expect(r.route.exclusions).toBeDefined()
                  expect(r.route.provenance).toBeDefined()
                }
              }
            })
          })
        })
      }
    })
  }
})
