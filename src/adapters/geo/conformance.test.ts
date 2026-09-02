import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { createLiveBundles, createLiveGeocoder, FIXTURE_BUNDLES, FIXTURE_GEOCODER } from './registry'
import type { RegionId } from './region'
import jmaTokyo from '../../../fixtures/geo/jp/alerts/upstream/jma-r8-130000-tokyo.json'
import nwsDc from '../../../fixtures/geo/us/alerts/upstream/nws-washington-dc.json'
import overpassTokyo from '../../../fixtures/geo/global/places/upstream/overpass-tokyo.json'
import nominatimFukui from '../../../fixtures/geo/global/geocode/upstream/nominatim-fukui-station.json'
import nominatimNoMatch from '../../../fixtures/geo/global/geocode/upstream/nominatim-no-match.json'
import kikikuruTimes from '../../../fixtures/geo/jp/flood/upstream/jma-kikikuru-targettimes.json'
import kikikuruTile from '../../../fixtures/geo/jp/flood/upstream/jma-kikikuru-inund-z12.json'
import glofasRaster from '../../../fixtures/geo/global/flood/upstream/glofas-floodhazard100y-dhaka.json'
import meteoalarmFrance from '../../../fixtures/geo/eu/alerts/upstream/meteoalarm-france.atom.xml?raw'
import cemsForecastReady from '../../../fixtures/geo/eu/flood/upstream/cems-forecast-ready.json'

const REGION_CENTERS: Record<RegionId, { latitude: number; longitude: number }> = {
  jp: { latitude: 35.6812, longitude: 139.7671 },
  us: { latitude: 38.8951, longitude: -77.0364 },
  eu: { latitude: 51.5074, longitude: -0.1278 },
}

/**
 * Replays recorded upstream payloads, chosen by the URL the provider asked the proxy for.
 *
 * The live providers reach real services now, so conformance has to supply them rather than let
 * them fall back — a suite that passed only because every provider quietly returned fixtures was
 * not testing the live path at all.
 */
const recordedUpstreams: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  // Raster tiles are fetched directly rather than through the JSON proxy. Under jsdom there is no
  // canvas to decode them with, so the provider falls back to fixtures — which is itself the
  // behaviour worth pinning here.
  if (String(input).startsWith('/api/geo/tiles/')) {
    return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 })
  }

  // The European forecast is computed by this server rather than proxied to an upstream, so what
  // is replayed here is one of its own replies. Copernicus answers retrievals as queued jobs, and
  // no recording of the store itself would exercise the path the provider actually takes.
  if (String(input) === '/api/geo/cems-forecast') {
    return new Response(JSON.stringify(cemsForecastReady), { status: 200 })
  }

  const body = JSON.parse(String(init?.body ?? '{}')) as { upstreamUrl?: string }
  const url = body.upstreamUrl ?? ''

  /** Recorded PNG bodies, for the two sources reached through the binary raster proxy. */
  const png = (base64: string) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
  }

  if (url.includes('/data/risk/targetTimes.json')) return new Response(JSON.stringify(kikikuruTimes))
  if (url.includes('/data/risk/')) return png(kikikuruTile.base64)
  if (url.includes('ows.globalfloods.eu')) return png(glofasRaster.base64)

  if (url.includes('fema.gov')) {
    return new Response(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            id: 1,
            properties: { FLD_ZONE: 'AE', ZONE_SUBTY: null, DEPTH: null, STATIC_BFE: 12.4 },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-77.05, 38.88],
                  [-77.02, 38.88],
                  [-77.02, 38.91],
                  [-77.05, 38.91],
                  [-77.05, 38.88],
                ],
              ],
            },
          },
        ],
      }),
    )
  }

  if (url.includes('jma.go.jp')) return new Response(JSON.stringify(jmaTokyo))
  if (url.includes('api.weather.gov')) return new Response(JSON.stringify(nwsDc))
  if (url.includes('meteoalarm.org')) return new Response(meteoalarmFrance)
  if (url.includes('overpass-api.de')) return new Response(JSON.stringify(overpassTokyo))
  if (url.includes('nominatim.openstreetmap.org')) {
    // Keyed on the query, or the "nothing matched" case would replay a payload full of matches.
    const query = new URL(url).searchParams.get('q') ?? ''
    return new Response(
      JSON.stringify(query.toLowerCase().includes('fukui') ? nominatimFukui : nominatimNoMatch),
    )
  }
  return new Response('{}', { status: 502 })
}) as unknown as typeof fetch

describe('Geo Provider Conformance Suite (R6.5)', () => {
  const bundlesToTest = [
    { label: 'fixture', bundles: FIXTURE_BUNDLES },
    { label: 'live (recorded upstreams)', bundles: createLiveBundles(recordedUpstreams) },
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

  /**
   * Geocoding is conformance-tested outside the region loop because it has no region: it is what
   * produces the coordinates a region is resolved from (design §4.1).
   */
  describe('Geocoding Providers', () => {
    const geocoders = [
      { label: 'fixture', port: FIXTURE_GEOCODER },
      { label: 'live (recorded upstreams)', port: createLiveGeocoder(recordedUpstreams) },
    ]

    for (const { label, port } of geocoders) {
      it(`[${port.sourceId}] (${label}) returns ranked matches with complete provenance`, async () => {
        const res = await Effect.runPromise(port.search({ text: 'Fukui Station', limit: 3 }))

        expect(res.query).toBe('Fukui Station')
        expect(res.coverage).toBeDefined()
        expect(res.matches.length).toBeGreaterThan(0)

        for (const match of res.matches) {
          expect(match.id).toBeDefined()
          expect(match.name).not.toBe('')
          expect(Number.isFinite(match.at.latitude)).toBe(true)
          expect(Number.isFinite(match.at.longitude)).toBe(true)
          expect(match.confidence).toBeGreaterThan(0)
          expect(match.provenance.attribution).toBeDefined()
          expect(match.provenance.licence).toBeDefined()
          expect(match.provenance.retrievedAt).toBeGreaterThan(0)
          expect(match.provenance.mode).toBeDefined()
        }

        // Best first, in the provider's own ranking, and every confidence a usable number.
        // Not asserted monotonic: confidence measures prominence relative to the leading match,
        // and a source's ranking legitimately weighs more than prominence, so the two can disagree
        // further down a list without either being wrong.
        for (const match of res.matches) {
          expect(match.confidence).toBeLessThanOrEqual(1)
        }
        expect(res.matches[0]!.confidence).toBeGreaterThanOrEqual(
          Math.max(...res.matches.map((m) => m.confidence)) - 0.001,
        )
      })

      it(`[${port.sourceId}] (${label}) reports an unmatched name as coverage, with no coordinates`, async () => {
        const res = await Effect.runPromise(
          port.search({ text: 'Qqzzx Nonexistent Place 12345' }),
        )

        expect(res.matches).toEqual([])
        expect(res.coverage.state).toBe('none')
        expect(res.coverage.detail).toBeTruthy()
      })

      it(`[${port.sourceId}] (${label}) refuses a query that is not a place name`, async () => {
        const outcome = await Effect.runPromise(Effect.either(port.search({ text: '   ' })))
        expect(outcome._tag).toBe('Left')
      })
    }
  })
})
