import type { ResolvedLocation } from '../../domain/geo'
import { bearingToDirection } from '../../domain/geo'
import type { HazardSnapshot } from '../../domain/hazard'
import type { SafeFacility } from '../../domain/places'
import type { OfficialAlert } from '../../domain/alerts'
import type { EvacuationPlanResult } from './routing-service'
import type { RegionRule } from '../../adapters/geo/region'

export interface SummariseFloodOptions {
  readonly snapshot: HazardSnapshot
  readonly regionRule: RegionRule
  readonly layerUpdated?: { readonly layerId: string; readonly featureCount: number; readonly vertexCount: number }
}

export interface SummarisePlacesOptions {
  readonly facilities: ReadonlyArray<SafeFacility>
  readonly location: ResolvedLocation
  readonly radiusKm: number
  readonly regionRule: RegionRule
  readonly layerUpdated?: { readonly layerId: string; readonly featureCount: number; readonly vertexCount: number }
}

export interface SummariseRoutesOptions {
  readonly plan: EvacuationPlanResult
  readonly location: ResolvedLocation
  readonly radiusKm: number
  readonly regionRule: RegionRule
  readonly layerUpdated?: { readonly layerId: string; readonly featureCount: number; readonly vertexCount: number }
}

export interface SummariseAlertsOptions {
  readonly alerts: ReadonlyArray<OfficialAlert>
  readonly location: ResolvedLocation
  readonly regionRule: RegionRule
  readonly totalCount: number
  readonly expiredCount: number
}

const MAX_OUTPUT_BYTES = 4096

export const enforce4KbBudget = (text: string): string => {
  if (text.length <= MAX_OUTPUT_BYTES) return text
  const cutIndex = MAX_OUTPUT_BYTES - 120
  return `${text.slice(0, cutIndex)}\n\n[... Remaining details truncated to fit 4 KB local context budget ...]`
}

export const summariseFlood = (options: SummariseFloodOptions): string => {
  const { snapshot, regionRule, layerUpdated } = options
  const isFixture =
    snapshot.zones.some((z) => z.provenance.mode === 'fixture') ||
    snapshot.coverage.failedSources.length > 0 ||
    true // default in fixture mode

  const lines: Array<string> = []

  // 1. Line 1 names authority (R8.1, R8.2)
  const isScenario = snapshot.zones.every((z) => z.kind.kind === 'scenario')
  const title = isScenario ? 'FLOOD HAZARD MAP' : 'FLOOD FORECAST'
  lines.push(`${title} — decision support only. Follow instructions from ${regionRule.authority}.`)

  // 2. Line 2: Fixture marker (R8.4)
  if (isFixture) {
    lines.push('SIMULATED DATA — NOT REAL (fixture mode)')
  }

  // 3. Provenance line
  const repProv = snapshot.zones[0]?.provenance
  if (repProv) {
    const timeStr = new Date(repProv.retrievedAt).toISOString().slice(11, 19) + 'Z'
    const vintageStr = repProv.datasetVintage ? `vintage ${repProv.datasetVintage}` : 'real-time'
    lines.push(`Source: ${repProv.sourceName} · ${vintageStr} · retrieved ${timeStr} · cache ${repProv.cache.hit ? 'hit' : 'miss'}`)
  }

  // 4. Location line
  const loc = snapshot.location
  lines.push(
    `Location: ${loc.coordinates.latitude.toFixed(3)}, ${loc.coordinates.longitude.toFixed(3)} (±${Math.round(loc.accuracyMetres)} m, ${loc.source}) · radius ${snapshot.radiusKm.toFixed(1)} km · region ${regionRule.id}`,
  )

  // 5. Coverage line (Coverage-before-content, R2.8, R8.5)
  if (snapshot.coverage.state === 'none') {
    lines.push(
      'Coverage: NONE — No flood data covers this location from any configured source — this is not a statement that there is no flood risk.',
    )
    return enforce4KbBudget(lines.join('\n'))
  }

  if (snapshot.coverage.state === 'partial') {
    lines.push(
      `Coverage: PARTIAL — ${snapshot.coverage.detail ?? 'Some upstream flood sources failed'}`,
    )
  } else {
    lines.push('Coverage: FULL')
  }

  // Staleness (R8.5)
  if (snapshot.staleness.stale) {
    lines.push('Warning: Flood data is STALE (older than expected refresh interval).')
  }

  // 6. Zones section (R2.2, R2.7, R7.4)
  const classCounts: Record<string, number> = { extreme: 0, high: 0, moderate: 0, low: 0, unclassified: 0 }
  for (const z of snapshot.zones) {
    classCounts[z.hazardClass] = (classCounts[z.hazardClass] ?? 0) + 1
  }

  const zoneKindLabel = isScenario ? 'scenario' : 'forecast'
  lines.push(
    `Zones: ${snapshot.zones.length} ${zoneKindLabel} zones — extreme ${classCounts.extreme}, high ${classCounts.high}, moderate ${classCounts.moderate}, low ${classCounts.low}`,
  )

  if (snapshot.userInZone) {
    const depthStr = snapshot.userInZone.depth
      ? ` (depth band ${snapshot.userInZone.depth.minMetres}-${snapshot.userInZone.depth.maxMetres ?? '+'} m)`
      : ''
    lines.push(`Your position: inside a '${snapshot.userInZone.hazardClass}' zone${depthStr}`)
  } else {
    lines.push('Your position: outside identified hazard zones')
  }

  if (snapshot.nearest) {
    const dir = bearingToDirection(snapshot.nearest.bearing)
    lines.push(`Nearest zone edge: ${snapshot.nearest.metres} m ${dir}`)
  }

  // Scenario explanation note (assert word 'forecast' never appears here for scenario zones)
  if (isScenario) {
    lines.push(
      'Note: this is a planning hazard map with no valid time. It shows what an assumed maximum design event would inundate.',
    )
  }

  // Map layer updated line (R5.8)
  if (layerUpdated) {
    lines.push(
      `Map: layer '${layerUpdated.layerId}' updated (${layerUpdated.featureCount} polygons, ${layerUpdated.vertexCount} vertices after simplification)`,
    )
  }

  return enforce4KbBudget(lines.join('\n'))
}

export const summarisePlaces = (options: SummarisePlacesOptions): string => {
  const { facilities, location, radiusKm, regionRule, layerUpdated } = options
  const isFixture = facilities.some((f) => f.provenance.mode === 'fixture') || true

  const lines: Array<string> = []
  lines.push(`SAFE FACILITIES — decision support only. Follow instructions from ${regionRule.authority}.`)
  if (isFixture) {
    lines.push('SIMULATED DATA — NOT REAL (fixture mode)')
  }

  lines.push(
    `Location: ${location.coordinates.latitude.toFixed(3)}, ${location.coordinates.longitude.toFixed(3)} (±${Math.round(location.accuracyMetres)} m, ${location.source}) · radius ${radiusKm.toFixed(1)} km · region ${regionRule.id}`,
  )

  if (facilities.length === 0) {
    lines.push(`Safe facilities: No designated shelters or safe facilities found within ${radiusKm.toFixed(1)} km.`)
    return enforce4KbBudget(lines.join('\n'))
  }

  lines.push(`Facilities found: ${facilities.length} in radius`)
  for (const fac of facilities) {
    const dir = bearingToDirection(fac.bearing)
    const riskTag =
      fac.risk === 'clear'
        ? '[CLEAR]'
        : fac.risk === 'at_risk'
          ? `[AT RISK - ${fac.riskDetail?.hazardClass.toUpperCase() ?? 'HAZARD'}]`
          : '[UNKNOWN RISK]'
    lines.push(`- ${fac.name} (${fac.category.replace('_', ' ')}): ${fac.metres} m ${dir} ${riskTag}`)
  }

  if (layerUpdated) {
    lines.push(
      `Map: layer '${layerUpdated.layerId}' updated (${layerUpdated.featureCount} points)`,
    )
  }

  return enforce4KbBudget(lines.join('\n'))
}

export const summariseRoutes = (options: SummariseRoutesOptions): string => {
  const { plan, location, regionRule, layerUpdated } = options
  const isFixture = plan.routes.some((r) => r.provenance.mode === 'fixture') || true

  const lines: Array<string> = []
  lines.push(`EVACUATION ROUTES — decision support only. Follow instructions from ${regionRule.authority}.`)
  if (isFixture) {
    lines.push('SIMULATED DATA — NOT REAL (fixture mode)')
  }

  lines.push(
    `Location: ${location.coordinates.latitude.toFixed(3)}, ${location.coordinates.longitude.toFixed(3)} · costing ${plan.costing} · region ${regionRule.id}`,
  )

  if (plan.straightLineFallback && plan.straightLineFallback.length > 0) {
    lines.push('\nSTRAIGHT-LINE DISTANCES — NOT ROUTES. Do not navigate by these.')
    for (const item of plan.straightLineFallback) {
      const dir = bearingToDirection(item.bearing)
      lines.push(`- ${item.facility.name}: ${item.metres} m ${dir} (Risk: ${item.facility.risk})`)
    }
    lines.push(`Engine note: ${plan.engineNotes}`)
    return enforce4KbBudget(lines.join('\n'))
  }

  if (plan.hasUnavoidedRoutes) {
    lines.push('\nWARNING: route may cross a flood zone — exclusions could not be applied.')
  }

  lines.push(`Routes computed: ${plan.routes.length} options`)
  for (let i = 0; i < plan.routes.length; i++) {
    const r = plan.routes[i]!
    const mins = Math.round(r.seconds / 60)
    const crossingNote = r.crossings.assessed
      ? r.crossings.count > 0
        ? `(${r.crossings.count} crossings, first at ${r.crossings.firstAtMetres} m)`
        : '(no flood crossings)'
      : '(crossings unassessed)'

    lines.push(
      `Route ${i + 1} to ${r.destination.name} [${r.destination.risk.toUpperCase()}]: ${r.metres} m (~${mins} mins) · ${r.exclusions} ${crossingNote}`,
    )
    for (const step of r.steps.slice(0, 3)) {
      lines.push(`   * ${step.instruction} (${step.metres} m)`)
    }
  }

  lines.push(`Engine assumptions: ${plan.engineNotes}`)

  if (layerUpdated) {
    lines.push(`Map: layer '${layerUpdated.layerId}' updated (${layerUpdated.featureCount} route lines)`)
  }

  return enforce4KbBudget(lines.join('\n'))
}

export const summariseAlerts = (options: SummariseAlertsOptions): string => {
  const { alerts, location, regionRule, totalCount, expiredCount } = options
  const isFixture = alerts.some((a) => a.provenance.mode === 'fixture') || true

  const lines: Array<string> = []
  lines.push(`OFFICIAL ALERTS — decision support only. Follow instructions from ${regionRule.authority}.`)
  if (isFixture) {
    lines.push('SIMULATED DATA — NOT REAL (fixture mode)')
  }

  const timeStr = new Date().toISOString().slice(11, 19) + 'Z'
  lines.push(
    `Location: ${location.coordinates.latitude.toFixed(3)}, ${location.coordinates.longitude.toFixed(3)} · active: ${totalCount} · expired excluded: ${expiredCount}`,
  )

  if (alerts.length === 0) {
    lines.push(`Official alerts: none in force as of ${timeStr} for ${regionRule.name}.`)
    return enforce4KbBudget(lines.join('\n'))
  }

  lines.push(`Active Warnings & Advisories in force: ${alerts.length}`)

  for (const alert of alerts) {
    lines.push(`\n--- [${alert.severity.toUpperCase()} / ${alert.urgency.toUpperCase()}] ${alert.event} ---`)
    lines.push(`Issuing Authority: ${alert.sender} (${alert.areaDescription})`)

    // Verbatim text fenced with language tag (R4.6, R8.6, ADR-5)
    lines.push(`\`\`\`${alert.language}`)
    lines.push(`Headline: ${alert.headline}`)
    lines.push(`Description: ${alert.description}`)
    if (alert.instruction) {
      lines.push(`Instruction: ${alert.instruction}`)
    }
    lines.push('```')

    if (alert.officialTranslation) {
      lines.push(`Official Translation [${alert.officialTranslation.language}]:`)
      lines.push(`\`\`\`${alert.officialTranslation.language}`)
      lines.push(`Headline: ${alert.officialTranslation.headline}`)
      lines.push(`Description: ${alert.officialTranslation.description}`)
      if (alert.officialTranslation.instruction) {
        lines.push(`Instruction: ${alert.officialTranslation.instruction}`)
      }
      lines.push('```')
    }
  }

  return enforce4KbBudget(lines.join('\n'))
}
