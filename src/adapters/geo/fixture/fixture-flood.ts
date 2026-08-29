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

    // If query is far from static fixtures, generate simulated local flood zones around query.at
    const hasNearby = zones.some((z) => {
      const ring = z.geometry.coordinates[0]
      const coord = ring ? ring[0] : null
      if (!coord || coord.length < 2) return false
      const lon = Number(coord[0])
      const lat = Number(coord[1])
      const dLat = (lat - query.at.latitude) * 111
      const dLon = (lon - query.at.longitude) * 111 * Math.cos((lat * Math.PI) / 180)
      return Math.sqrt(dLat * dLat + dLon * dLon) <= query.radiusKm + 20
    })

    if (!hasNearby) {
      const lon = query.at.longitude
      const lat = query.at.latitude
      const simZones: Array<FloodZone> = [
        {
          id: `${this.region}-sim-flood-high`,
          kind: { kind: 'scenario', designEvent: 'L2 assumed maximum flood' },
          hazardClass: 'high',
          depth: { minMetres: 3.0, maxMetres: 5.0 },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [lon - 0.006, lat - 0.008],
                [lon + 0.012, lat - 0.005],
                [lon + 0.015, lat + 0.008],
                [lon - 0.003, lat + 0.006],
                [lon - 0.006, lat - 0.008],
              ],
            ],
          },
          provenance,
        },
        {
          id: `${this.region}-sim-flood-moderate`,
          kind: { kind: 'scenario', designEvent: 'L2 assumed maximum flood' },
          hazardClass: 'moderate',
          depth: { minMetres: 0.5, maxMetres: 3.0 },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [lon - 0.010, lat - 0.012],
                [lon + 0.018, lat - 0.008],
                [lon + 0.020, lat + 0.012],
                [lon - 0.007, lat + 0.010],
                [lon - 0.010, lat - 0.012],
              ],
            ],
          },
          provenance,
        },
      ]
      zones.push(...simZones)
    }

    return Effect.succeed({
      zones,
      coverage: {
        state: zones.length > 0 ? 'full' : 'none',
        failedSources: [],
      },
      staleness: { stale: false },
    })
  }
}
