import type { AlertsPort } from '../../ports/Alerts'
import type { FloodDataPort } from '../../ports/FloodData'
import type { GeocodingPort } from '../../ports/Geocoding'
import type { PlacesPort } from '../../ports/Places'
import type { RoutingPort } from '../../ports/Routing'
import type { RegionId } from './region'
import { JpFloodProvider } from './jp/flood'
import { JpAlertsProvider } from './jp/alerts'
import { JpKikikuruProvider } from './jp/kikikuru'
import { GlofasFloodProvider } from './glofas-flood'
import { UsFloodForecastProvider, UsFloodScenarioProvider } from './us/flood'
import { UsAlertsProvider } from './us/alerts'
import { EuFloodForecastProvider } from './eu/flood'
import { EuAlertsProvider } from './eu/alerts'
import { OverpassPlacesProvider } from './overpass-places'
import { NominatimGeocodingProvider } from './nominatim-geocoding'
import { StadiaRoutingProvider } from './routing/stadia'
import { FixtureFloodProvider } from './fixture/fixture-flood'
import { FixturePlacesProvider } from './fixture/fixture-places'
import { FixtureAlertsProvider } from './fixture/fixture-alerts'
import { FixtureRoutingProvider } from './fixture/fixture-routing'
import { FixtureGeocodingProvider } from './fixture/fixture-geocoding'

export interface RegionBundle {
  readonly flood: ReadonlyArray<FloodDataPort>
  readonly places: ReadonlyArray<PlacesPort>
  readonly alerts: ReadonlyArray<AlertsPort>
  readonly routing: RoutingPort
}

export type BundleRegistry = Record<RegionId, RegionBundle>

/**
 * The live bundles, built against a given `fetch`.
 *
 * Every live provider now actually calls an upstream, so the only way to exercise them off the
 * network is to hand them one. Production takes the default; tests pass a stub that replays
 * recorded JMA, NWS, MeteoAlarm and Overpass payloads.
 */
/**
 * A region's flood slot carries every product that has something to say about it, because they
 * answer different questions and a reader needs all of them (R2.2):
 *
 * - キキクル is the only source here that says what is dangerous **now**, on a ten-minute cycle.
 * - GSI L2 is the assumed-maximum planning envelope, with no valid time.
 * - GloFAS is a global 100-year model — coarser than any national map, and the only one that works
 *   outside the three regions the national sources cover.
 *
 * They are never merged into each other: `clipAndMergeZones` keys on kind and source as well as
 * hazard class, so a real-time risk level cannot be unioned into a planning scenario.
 */
export const createLiveBundles = (fetchImpl?: typeof fetch): BundleRegistry => ({
  jp: {
    flood: [
      new JpKikikuruProvider(fetchImpl),
      new JpFloodProvider(fetchImpl),
      new GlofasFloodProvider(fetchImpl),
    ],
    places: [new OverpassPlacesProvider('jp', fetchImpl)],
    alerts: [new JpAlertsProvider(fetchImpl)],
    routing: new StadiaRoutingProvider(fetchImpl),
  },
  us: {
    flood: [
      new UsFloodForecastProvider(),
      new UsFloodScenarioProvider(fetchImpl),
      new GlofasFloodProvider(fetchImpl),
    ],
    places: [new OverpassPlacesProvider('us', fetchImpl)],
    alerts: [new UsAlertsProvider(fetchImpl)],
    routing: new StadiaRoutingProvider(fetchImpl),
  },
  eu: {
    // Two GloFAS products, answering different questions and never merged: the forecast says what
    // the ensemble expects over the next five days, the 100-year layer is a planning envelope with
    // no valid time. EFAS, the European product proper, is a thirty-day-delayed feed for anyone
    // who is not a CEMS partner, which is no use as a forecast — see `eu/flood.ts`.
    flood: [new EuFloodForecastProvider(fetchImpl), new GlofasFloodProvider(fetchImpl)],
    places: [new OverpassPlacesProvider('eu', fetchImpl)],
    alerts: [new EuAlertsProvider(fetchImpl)],
    routing: new StadiaRoutingProvider(fetchImpl),
  },
})

export const LIVE_BUNDLES: BundleRegistry = createLiveBundles()

export const FIXTURE_BUNDLES: BundleRegistry = {
  jp: {
    flood: [new FixtureFloodProvider('jp')],
    places: [new FixturePlacesProvider('jp')],
    alerts: [new FixtureAlertsProvider('jp')],
    routing: new FixtureRoutingProvider(),
  },
  us: {
    flood: [new FixtureFloodProvider('us')],
    places: [new FixturePlacesProvider('us')],
    alerts: [new FixtureAlertsProvider('us')],
    routing: new FixtureRoutingProvider(),
  },
  eu: {
    flood: [new FixtureFloodProvider('eu')],
    places: [new FixturePlacesProvider('eu')],
    alerts: [new FixtureAlertsProvider('eu')],
    routing: new FixtureRoutingProvider(),
  },
}

/**
 * The bundles for a data mode, with routing resolved separately (R3.11).
 *
 * Routing takes its own mode because the recorded replies only cover the place they were captured
 * at: away from it the fixture engine can offer a straight line and nothing else, and a straight
 * line is never drawn as a route. Tying routing to `mode` therefore meant a map with no routes on
 * it anywhere but one street corner in Tokyo. Simulated hazard data with real road routes is both
 * honest — each carries its own provenance — and the only combination that works everywhere.
 */
export const getRegistryForMode = (
  mode: 'live' | 'fixture' = 'fixture',
  routingMode: 'live' | 'fixture' = mode,
): BundleRegistry => {
  const bundles = mode === 'live' ? LIVE_BUNDLES : FIXTURE_BUNDLES
  if (routingMode === mode) return bundles

  const routing = routingMode === 'live' ? LIVE_BUNDLES.jp.routing : FIXTURE_BUNDLES.jp.routing
  return {
    jp: { ...bundles.jp, routing },
    us: { ...bundles.us, routing },
    eu: { ...bundles.eu, routing },
  }
}

/**
 * Geocoding sits outside `RegionBundle` on purpose.
 *
 * Every other provider is chosen by the region the user is in, which is resolved from coordinates.
 * A geocoder is what produces those coordinates in the first place, so selecting one by region
 * would be circular — and the answer to "where is Fukui Station" must not depend on where the
 * asker happens to be standing.
 */
export const createLiveGeocoder = (fetchImpl?: typeof fetch): GeocodingPort =>
  new NominatimGeocodingProvider(fetchImpl)

export const LIVE_GEOCODER: GeocodingPort = createLiveGeocoder()
export const FIXTURE_GEOCODER: GeocodingPort = new FixtureGeocodingProvider()

export const getGeocoderForMode = (mode: 'live' | 'fixture' = 'fixture'): GeocodingPort =>
  mode === 'live' ? LIVE_GEOCODER : FIXTURE_GEOCODER
