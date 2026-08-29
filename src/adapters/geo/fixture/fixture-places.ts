import { Effect } from 'effect'
import type { Bearing, LonLat } from '../../../domain/geo'
import type { FacilityCategory, SafeFacility } from '../../../domain/places'
import type { Provenance } from '../../../domain/provenance'
import type { PlacesPort, PlacesQuery, PlacesQueryResult } from '../../../ports/Places'
import type { ProviderMeta } from '../../../ports/FloodData'
import jpPlaces from '../../../../fixtures/geo/jp/places/normal.json'
import usPlaces from '../../../../fixtures/geo/us/places/normal.json'
import euPlaces from '../../../../fixtures/geo/eu/places/normal.json'
import type { RegionId } from '../region'

interface FixtureFacilityItem {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly longitude: number
  readonly latitude: number
}

interface FixturePlacesFile {
  readonly capturedAt: number
  readonly upstreamUrl: string
  readonly sourceId: string
  readonly licence: string
  readonly attribution: string
  readonly facilities?: ReadonlyArray<FixtureFacilityItem>
}

const calculateDistanceAndBearing = (
  from: LonLat,
  to: LonLat,
): { metres: number; bearing: Bearing } => {
  const dLat = (to.latitude - from.latitude) * (Math.PI / 180)
  const dLon = (to.longitude - from.longitude) * (Math.PI / 180)
  const lat1 = from.latitude * (Math.PI / 180)
  const lat2 = to.latitude * (Math.PI / 180)

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  const metres = Math.round(6371000 * c)

  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  const bearingDeg = Math.round((((Math.atan2(y, x) * 180) / Math.PI) % 360 + 360) % 360)

  return { metres, bearing: bearingDeg }
}

export class FixturePlacesProvider implements PlacesPort {
  readonly sourceId: string
  readonly meta: ProviderMeta
  private readonly region: RegionId

  constructor(region: RegionId = 'jp') {
    this.region = region
    this.sourceId = `${region}.fixture.places`
    this.meta = {
      sourceId: this.sourceId,
      sourceName: `Simulated ${region.toUpperCase()} Places Provider`,
      docsUrl: 'https://example.com/docs/fixture-places',
      vintage: '2026-04-fixture',
      licence: 'Fixture Test Data',
      attribution: `Simulated ${region.toUpperCase()} Designated Shelters (Fixture Mode)`,
      expectedRefreshMs: 86_400_000,
    }
  }

  facilitiesWithin(query: PlacesQuery): Effect.Effect<PlacesQueryResult, never> {
    const rawData: FixturePlacesFile =
      this.region === 'jp' ? jpPlaces : this.region === 'us' ? usPlaces : euPlaces

    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: rawData.upstreamUrl,
      datasetVintage: '2026-04',
      retrievedAt: Date.now(),
      cache: { hit: false, ageMs: 0 },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'fixture',
    }

    const maxRadiusMetres = query.radiusKm * 1000

    let facilities: Array<SafeFacility> = (rawData.facilities || [])
      .map((f) => {
        const at: LonLat = { longitude: f.longitude, latitude: f.latitude }
        const { metres, bearing } = calculateDistanceAndBearing(query.at, at)
        return {
          id: f.id,
          name: f.name,
          category: f.category as FacilityCategory,
          at,
          metres,
          bearing,
          risk: 'unknown' as const,
          provenance,
        }
      })
      .filter((f) => f.metres <= maxRadiusMetres)

    // If query is outside static reference city, generate nearby simulated shelters in the user's vicinity
    if (facilities.length === 0) {
      const templates =
        this.region === 'jp'
          ? [
              {
                offsetLat: 0.006,
                offsetLon: 0.003,
                name: '指定緊急避難場所 (北部地区センター)',
                category: 'evacuation_site' as const,
              },
              {
                offsetLat: 0.002,
                offsetLon: 0.010,
                name: '指定避難所 (東部コミュニティスクール)',
                category: 'evacuation_shelter' as const,
              },
              {
                offsetLat: -0.011,
                offsetLon: -0.004,
                name: '広域避難拠点 (南部防災交流館)',
                category: 'public_facility' as const,
              },
              {
                offsetLat: 0.004,
                offsetLon: -0.015,
                name: '緊急一時避難場所 (西部中央公園)',
                category: 'evacuation_site' as const,
              },
              {
                offsetLat: -0.007,
                offsetLon: 0.012,
                name: '第1指定避難所 (総合体育館)',
                category: 'evacuation_shelter' as const,
              },
            ]
          : this.region === 'us'
            ? [
                {
                  offsetLat: 0.007,
                  offsetLon: 0.003,
                  name: 'North District Emergency Shelter',
                  category: 'evacuation_shelter' as const,
                },
                {
                  offsetLat: 0.002,
                  offsetLon: 0.010,
                  name: 'East Community High School Safe Hub',
                  category: 'evacuation_shelter' as const,
                },
                {
                  offsetLat: -0.010,
                  offsetLon: -0.004,
                  name: 'South Civic Center Disaster Station',
                  category: 'public_facility' as const,
                },
                {
                  offsetLat: 0.005,
                  offsetLon: -0.014,
                  name: 'West Regional Park Assembly Area',
                  category: 'evacuation_site' as const,
                },
              ]
            : [
                {
                  offsetLat: 0.006,
                  offsetLon: 0.003,
                  name: 'Nord Evakuierungszentrum',
                  category: 'evacuation_shelter' as const,
                },
                {
                  offsetLat: 0.002,
                  offsetLon: 0.010,
                  name: 'Ost Gemeinschaftsschule Notunterkunft',
                  category: 'evacuation_shelter' as const,
                },
                {
                  offsetLat: -0.011,
                  offsetLon: -0.004,
                  name: 'Süd Katastrophenschutzzentrum',
                  category: 'public_facility' as const,
                },
                {
                  offsetLat: 0.004,
                  offsetLon: -0.015,
                  name: 'West Stadtpark Schutzbereich',
                  category: 'evacuation_site' as const,
                },
              ]

      facilities = templates
        .map((tpl, i) => {
          const at: LonLat = {
            latitude: query.at.latitude + tpl.offsetLat,
            longitude: query.at.longitude + tpl.offsetLon,
          }
          const { metres, bearing } = calculateDistanceAndBearing(query.at, at)
          return {
            id: `${this.region}-sim-fac-${i + 1}`,
            name: tpl.name,
            category: tpl.category,
            at,
            metres,
            bearing,
            risk: 'unknown' as const,
            provenance,
          }
        })
        .filter((f) => f.metres <= maxRadiusMetres)
    }

    const limitedFacilities = facilities.slice(0, query.limit ?? 10)

    return Effect.succeed({
      facilities: limitedFacilities,
      coverage: {
        state: limitedFacilities.length > 0 ? 'full' : 'none',
        failedSources: [],
      },
      staleness: { stale: false },
    })
  }
}
