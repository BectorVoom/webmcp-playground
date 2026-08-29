import { Effect } from 'effect'
import type { PlacesPort, PlacesQuery, PlacesQueryResult } from '../../../ports/Places'
import type { ProviderMeta } from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { FixturePlacesProvider } from '../fixture/fixture-places'

export class EuPlacesProvider implements PlacesPort {
  readonly sourceId = 'eu.osm.shelters'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'OpenStreetMap Emergency Facilities',
    docsUrl: 'https://wiki.openstreetmap.org/wiki/Key:emergency',
    licence: 'ODbL 1.0',
    attribution: '© OpenStreetMap contributors',
    expectedRefreshMs: 86_400_000,
  }

  private readonly fixture = new FixturePlacesProvider('eu')

  facilitiesWithin(query: PlacesQuery): Effect.Effect<PlacesQueryResult, GeoError> {
    return this.fixture.facilitiesWithin(query).pipe(
      Effect.map((res) => ({
        ...res,
        facilities: res.facilities.map((f) => ({
          ...f,
          provenance: {
            ...f.provenance,
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
