import { Effect } from 'effect'
import type { PlacesPort, PlacesQuery, PlacesQueryResult } from '../../../ports/Places'
import type { ProviderMeta } from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { FixturePlacesProvider } from '../fixture/fixture-places'

export class UsPlacesProvider implements PlacesPort {
  readonly sourceId = 'us.fema.shelters'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'FEMA National Shelter System',
    docsUrl: 'https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer',
    vintage: '2026-04',
    licence: 'U.S. Public Domain',
    attribution: 'FEMA National Shelter System / American Red Cross',
    expectedRefreshMs: 1800_000,
  }

  private readonly fixture = new FixturePlacesProvider('us')

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
