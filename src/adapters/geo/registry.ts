import type { AlertsPort } from '../../ports/Alerts'
import type { FloodDataPort } from '../../ports/FloodData'
import type { PlacesPort } from '../../ports/Places'
import type { RoutingPort } from '../../ports/Routing'
import type { RegionId } from './region'
import { JpFloodProvider } from './jp/flood'
import { JpPlacesProvider } from './jp/places'
import { JpAlertsProvider } from './jp/alerts'
import { UsFloodForecastProvider, UsFloodScenarioProvider } from './us/flood'
import { UsPlacesProvider } from './us/places'
import { UsAlertsProvider } from './us/alerts'
import { EuFloodForecastProvider } from './eu/flood'
import { EuPlacesProvider } from './eu/places'
import { EuAlertsProvider } from './eu/alerts'
import { ValhallaRoutingProvider } from './routing/valhalla'
import { FixtureFloodProvider } from './fixture/fixture-flood'
import { FixturePlacesProvider } from './fixture/fixture-places'
import { FixtureAlertsProvider } from './fixture/fixture-alerts'
import { FixtureRoutingProvider } from './fixture/fixture-routing'

export interface RegionBundle {
  readonly flood: ReadonlyArray<FloodDataPort>
  readonly places: ReadonlyArray<PlacesPort>
  readonly alerts: ReadonlyArray<AlertsPort>
  readonly routing: RoutingPort
}

export type BundleRegistry = Record<RegionId, RegionBundle>

export const LIVE_BUNDLES: BundleRegistry = {
  jp: {
    flood: [new JpFloodProvider()],
    places: [new JpPlacesProvider()],
    alerts: [new JpAlertsProvider()],
    routing: new ValhallaRoutingProvider(),
  },
  us: {
    flood: [new UsFloodForecastProvider(), new UsFloodScenarioProvider()],
    places: [new UsPlacesProvider()],
    alerts: [new UsAlertsProvider()],
    routing: new ValhallaRoutingProvider(),
  },
  eu: {
    flood: [new EuFloodForecastProvider()],
    places: [new EuPlacesProvider()],
    alerts: [new EuAlertsProvider()],
    routing: new ValhallaRoutingProvider(),
  },
}

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

export const getRegistryForMode = (mode: 'live' | 'fixture' = 'fixture'): BundleRegistry =>
  mode === 'live' ? LIVE_BUNDLES : FIXTURE_BUNDLES
