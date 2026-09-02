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
  readonly alertsCoverage: Coverage
  readonly totalAlertCount: number
  readonly expiredAlertCount: number
}

/**
 * One coverage line for however many alert feeds a region bundle holds.
 *
 * `no_data_for_area` only survives while nothing was found at all: one feed not reaching the user
 * does not make the alerts another feed did return any less complete.
 */
const mergeAlertsCoverage = (
  alertCount: number,
  coverages: ReadonlyArray<Coverage>,
  failedSources: ReadonlyArray<{ readonly sourceId: string; readonly error: string }>,
): Coverage => {
  if (coverages.length === 0) {
    return { state: 'none', reason: 'source_failed', failedSources }
  }
  if (alertCount === 0) {
    const noData = coverages.find((c) => c.reason === 'no_data_for_area')
    if (noData) return { ...noData, failedSources }
  }
  const degraded = coverages.find((c) => c.state !== 'full')
  if (degraded) return { ...degraded, state: 'partial', failedSources }
  return { state: 'full', failedSources }
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
    // Each provider explains its own gaps — "this fixture was captured 300 km away", "GSI maps no
    // inundation within 20 km". Those sentences are the only thing that tells a reader whether an
    // empty map means no risk, no data, or the wrong data mode, and they used to be dropped here.
    const providerNotes: Array<string> = []

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
        if (floodRes.right.coverage.detail) providerNotes.push(floodRes.right.coverage.detail)
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
      detail: providerNotes.length > 0 ? providerNotes.join(' ') : undefined,
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
    const alertsCoverages: Array<Coverage> = []
    const failedAlertSources: Array<{ sourceId: string; error: string }> = []
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
        alertsCoverages.push(alertsRes.right.coverage)
        totalAlertCount += alertsRes.right.totalActiveCount
        expiredAlertCount += alertsRes.right.expiredCount
      } else {
        const failure = {
          sourceId: alertsProvider.sourceId,
          error: alertsRes.left.message ?? alertsRes.left._tag,
        }
        failedSources.push(failure)
        failedAlertSources.push(failure)
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
      alertsCoverage: mergeAlertsCoverage(alerts.length, alertsCoverages, failedAlertSources),
      totalAlertCount,
      expiredAlertCount,
    }
  })
}
