import { Effect } from 'effect'
import type { FloodDataPort, FloodQuery, FloodQueryResult, ProviderMeta } from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { FixtureFloodProvider } from '../fixture/fixture-flood'

export class UsFloodForecastProvider implements FloodDataPort {
  readonly sourceId = 'us.nws.forecast'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'NWS River & Flash Flood Forecasts',
    docsUrl: 'https://www.weather.gov/documentation/services-web-api',
    licence: 'U.S. Public Domain',
    attribution: 'National Oceanic and Atmospheric Administration / National Weather Service',
    expectedRefreshMs: 3600_000,
  }

  private readonly fixture = new FixtureFloodProvider('us')

  zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, GeoError> {
    return this.fixture.zonesWithin(query).pipe(
      Effect.map((res) => ({
        ...res,
        zones: res.zones
          .filter((z) => z.kind.kind === 'forecast')
          .map((z) => ({
            ...z,
            provenance: {
              ...z.provenance,
              sourceId: this.meta.sourceId,
              sourceName: this.meta.sourceName,
              attribution: this.meta.attribution,
              licence: this.meta.licence,
            },
          })),
      })),
    )
  }
}

export class UsFloodScenarioProvider implements FloodDataPort {
  readonly sourceId = 'us.fema.nfhl'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'FEMA National Flood Hazard Layer (NFHL)',
    docsUrl: 'https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer',
    vintage: '2025-10',
    licence: 'U.S. Public Domain',
    attribution: 'Federal Emergency Management Agency (FEMA) National Flood Hazard Layer',
    expectedRefreshMs: 86_400_000 * 180,
  }

  private readonly fixture = new FixtureFloodProvider('us')

  zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, GeoError> {
    return this.fixture.zonesWithin(query).pipe(
      Effect.map((res) => ({
        ...res,
        zones: res.zones
          .filter((z) => z.kind.kind === 'scenario')
          .map((z) => ({
            ...z,
            provenance: {
              ...z.provenance,
              sourceId: this.meta.sourceId,
              sourceName: this.meta.sourceName,
              attribution: this.meta.attribution,
              licence: this.meta.licence,
            },
          })),
      })),
    )
  }
}
