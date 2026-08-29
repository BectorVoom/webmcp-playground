import { Effect } from 'effect'
import type { ResolvedLocation } from '../../domain/geo'
import type { FloodZone, HazardSnapshot } from '../../domain/hazard'
import type { SafeFacility } from '../../domain/places'
import type { OfficialAlert } from '../../domain/alerts'
import type { Coverage, Staleness } from '../../domain/provenance'
import type { RegionBundle } from '../../adapters/geo/registry'
import { resolveRegion, type RegionId, type RegionRule } from '../../adapters/geo/region'
import { clipAndMergeZones } from '../../lib/geometry/clip'
import { simplifyZonesToBudget, countZonesVertices, MAP_VERTEX_BUDGET } from '../../lib/geometry/simplify'
import { assessFacilityRisk, findContainingZone, findNearestZoneEdge } from '../../lib/geometry/measure'
import type { GeoError } from '../../domain/geo-errors'

export interface CompleteHazardSnapshot {
  readonly location: ResolvedLocation
  readonly region: RegionId
  readonly regionRule: RegionRule
  readonly radiusKm: number
  readonly hazardSnapshot: HazardSnapshot
  readonly facilities: ReadonlyArray<SafeFacility>
  readonly alerts: ReadonlyArray<OfficialAlert>
  readonly totalAlertCount: number
  readonly expiredAlertCount: number
}

export interface BuildSnapshotOptions {
  readonly location: ResolvedLocation
  readonly radiusKm: number
  readonly bundle: RegionBundle
  readonly horizonHours?: number
  readonly signal?: AbortSignal
}

/**
 * Builds a complete hazard snapshot for a location (Phase 7.1, R6.9, R2.*, R4.*).
 */
export const buildHazardSnapshot = (
  options: BuildSnapshotOptions,
): Effect.Effect<CompleteHazardSnapshot, GeoError> => {
  const { location, radiusKm, bundle, horizonHours = 24, signal } = options

  return Effect.gen(function* () {
    const regionResolved = yield* resolveRegion(location.coordinates)
    const failedSources: Array<{ sourceId: string; error: string }> = []

    // 1. Query Flood Providers (multi-source merge R6.9)
    const rawZones: Array<FloodZone> = []
    let hasAnyFloodData = false
    let isAnyFloodStale = false

    for (const floodProvider of bundle.flood) {
      const floodRes = yield* Effect.either(
        floodProvider.zonesWithin({
          at: location.coordinates,
          radiusKm,
          horizonHours,
          signal,
        }),
      )

      if (floodRes._tag === 'Right') {
        hasAnyFloodData = true
        rawZones.push(...floodRes.right.zones)
        if (floodRes.right.staleness.stale) isAnyFloodStale = true
      } else {
        failedSources.push({
          sourceId: floodProvider.sourceId,
          error: floodRes.left.message ?? floodRes.left._tag,
        })
      }
    }

    // 2. Spatial Processing: Clip & Merge & Simplify (Phase 3)
    const clipped = clipAndMergeZones(rawZones, location.coordinates, radiusKm)
    const simplified = simplifyZonesToBudget(clipped.zones, MAP_VERTEX_BUDGET)
    const finalZones = simplified.zones

    const verticesIn = countZonesVertices(rawZones)
    const verticesOut = simplified.verticesOut

    const userInZone = findContainingZone(location.coordinates, finalZones)
    const nearest = findNearestZoneEdge(location.coordinates, finalZones)

    const floodCoverageState =
      !hasAnyFloodData && failedSources.length > 0
        ? ('none' as const)
        : failedSources.length > 0
          ? ('partial' as const)
          : rawZones.length === 0
            ? ('none' as const)
            : ('full' as const)

    const floodCoverage: Coverage = {
      state: floodCoverageState,
      reason:
        floodCoverageState === 'none'
          ? 'no_data_for_area'
          : floodCoverageState === 'partial'
            ? 'source_failed'
            : undefined,
      failedSources,
    }

    const staleness: Staleness = {
      stale: isAnyFloodStale,
    }

    const hazardSnapshot: HazardSnapshot = {
      location,
      radiusKm,
      zones: finalZones,
      userInZone,
      nearest,
      coverage: floodCoverage,
      staleness,
      geometryStats: {
        featuresIn: rawZones.length,
        verticesIn,
        verticesOut,
      },
    }

    // 3. Query Safe Facilities & Assess Risk (R3.1, R3.2)
    const rawFacilities: Array<SafeFacility> = []
    for (const placesProvider of bundle.places) {
      const placesRes = yield* Effect.either(
        placesProvider.facilitiesWithin({
          at: location.coordinates,
          radiusKm,
          limit: 20,
          signal,
        }),
      )

      if (placesRes._tag === 'Right') {
        rawFacilities.push(...placesRes.right.facilities)
      } else {
        failedSources.push({
          sourceId: placesProvider.sourceId,
          error: placesRes.left.message ?? placesRes.left._tag,
        })
      }
    }

    const hasFloodCoverage = floodCoverageState !== 'none'
    const assessedFacilities = rawFacilities.map((fac) => {
      const riskAssessment = assessFacilityRisk(fac.at, finalZones, hasFloodCoverage)
      return {
        ...fac,
        risk: riskAssessment.risk,
        riskDetail: riskAssessment.matchingZone
          ? {
              hazardClass: riskAssessment.matchingZone.hazardClass,
              depth: riskAssessment.matchingZone.depth,
            }
          : undefined,
      }
    })

    // 4. Query Alerts (R4.1-R4.10)
    const alerts: Array<OfficialAlert> = []
    let totalAlertCount = 0
    let expiredAlertCount = 0

    for (const alertsProvider of bundle.alerts) {
      const alertsRes = yield* Effect.either(
        alertsProvider.alertsFor({
          at: location.coordinates,
          radiusKm,
          limit: 10,
          signal,
        }),
      )

      if (alertsRes._tag === 'Right') {
        alerts.push(...alertsRes.right.alerts)
        totalAlertCount += alertsRes.right.totalActiveCount
        expiredAlertCount += alertsRes.right.expiredCount
      } else {
        failedSources.push({
          sourceId: alertsProvider.sourceId,
          error: alertsRes.left.message ?? alertsRes.left._tag,
        })
      }
    }

    return {
      location,
      region: regionResolved.region,
      regionRule: regionResolved.rule,
      radiusKm,
      hazardSnapshot,
      facilities: assessedFacilities,
      alerts,
      totalAlertCount,
      expiredAlertCount,
    }
  })
}
