import { Effect } from 'effect'
import type { DepthBand, FloodZone, HazardClass, ZoneKind } from '../../../domain/hazard'
import type { Provenance } from '../../../domain/provenance'
import type { FloodDataPort, FloodQuery, FloodQueryResult, ProviderMeta } from '../../../ports/FloodData'
import jpNormal from '../../../../fixtures/geo/jp/flood/normal.json'
import usNormal from '../../../../fixtures/geo/us/flood/normal.json'
import euNormal from '../../../../fixtures/geo/eu/flood/normal.json'
import type { RegionId } from '../region'

interface FixturePolygonItem {
  readonly id: string
  readonly hazardClass: string
  readonly kind?: string
  readonly designEvent?: string
  readonly validFrom?: number
  readonly validTo?: number
  readonly depth?: DepthBand
  readonly coordinates: number[][][]
}

interface FixtureFloodFile {
  readonly capturedAt: number
  readonly issuedAt?: number
  readonly upstreamUrl: string
  readonly sourceId: string
  readonly vintage?: string
  readonly licence: string
  readonly attribution: string
  readonly polygons?: ReadonlyArray<FixturePolygonItem>
}

export class FixtureFloodProvider implements FloodDataPort {
  readonly sourceId: string
  readonly meta: ProviderMeta
  private readonly region: RegionId

  constructor(region: RegionId = 'jp') {
    this.region = region
    this.sourceId = `${region}.fixture.flood`
    this.meta = {
      sourceId: this.sourceId,
      sourceName: `Simulated ${region.toUpperCase()} Flood Provider`,
      docsUrl: 'https://example.com/docs/fixture-flood',
      vintage: '2026-04-fixture',
      licence: 'Fixture Test Data',
      attribution: `Simulated ${region.toUpperCase()} Flood Hazard Data (Fixture Mode)`,
      expectedRefreshMs: 600_000,
    }
  }

  zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, never> {
    const rawData: FixtureFloodFile =
      this.region === 'jp' ? jpNormal : this.region === 'us' ? usNormal : euNormal

    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: rawData.upstreamUrl,
      datasetVintage: rawData.vintage ?? '2026-04',
      issuedAt: rawData.issuedAt ?? rawData.capturedAt,
      retrievedAt: Date.now(),
      cache: { hit: false, ageMs: 0 },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'fixture',
    }

    const zones: Array<FloodZone> = (rawData.polygons || []).map((p) => {
      const kind: ZoneKind =
        p.kind === 'forecast'
          ? {
              kind: 'forecast',
              validFrom: p.validFrom ?? Date.now(),
              validTo: p.validTo ?? Date.now() + 86_400_000,
            }
          : {
              kind: 'scenario',
              designEvent: p.designEvent ?? 'L2 assumed maximum',
            }

      return {
        id: p.id,
        kind,
        hazardClass: p.hazardClass as HazardClass,
        depth: p.depth,
        geometry: {
          type: 'Polygon',
          coordinates: p.coordinates as [number, number][][],
        },
        provenance,
      }
    })

    /**
     * Only the zones near the query.
     *
     * A fixture holds a handful of recorded areas — Tokyo and Fukui, for the JP file — and handing
     * a Fukui query the Tokyo polygons would put a hazard 300 km away into the answer. They would
     * be clipped out downstream, but the coverage state would already have claimed `full`, which
     * is the lie that matters: an empty map that says "full coverage" reads as "no flood risk".
     *
     * This used to be an all-or-nothing check across the whole file, so a file with two recorded
     * areas served both or neither. What it must never do is what it did before that: synthesise a
     * polygon centred on the query point whenever the recordings were far away, which told every
     * user in Japan they stood in a 3–5 m inundation zone that did not exist. An invented hazard is
     * worse than an absent one.
     */
    const inArea = zones.filter((z) => {
      const coord = z.geometry.coordinates[0]?.[0]
      if (!coord || coord.length < 2) return false
      const lon = Number(coord[0])
      const lat = Number(coord[1])
      const dLat = (lat - query.at.latitude) * 111
      const dLon = (lon - query.at.longitude) * 111 * Math.cos((lat * Math.PI) / 180)
      return Math.sqrt(dLat * dLat + dLon * dLon) <= query.radiusKm + 20
    })

    if (inArea.length === 0) {
      return Effect.succeed({
        zones: [],
        coverage: {
          state: 'none' as const,
          reason: 'no_data_for_area' as const,
          detail: `Fixture mode carries recorded ${this.region.toUpperCase()} flood zones only for the areas they were captured in, and none of them reaches this location. Set GEO_DATA_MODE=live to query the real hazard map here.`,
          failedSources: [],
        },
        staleness: { stale: false },
      })
    }

    return Effect.succeed({
      zones: inArea,
      coverage: {
        state: 'full' as const,
        detail: `Recorded ${this.region.toUpperCase()} flood zones for this area, generalised — simulated data standing in for the live hazard map.`,
        failedSources: [],
      },
      staleness: { stale: false },
    })
  }
}
