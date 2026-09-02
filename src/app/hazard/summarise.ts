import type { ResolvedLocation } from '../../domain/geo'
import { bearingToDirection } from '../../domain/geo'
import type { HazardSnapshot } from '../../domain/hazard'
import type { SafeFacility } from '../../domain/places'
import type { OfficialAlert } from '../../domain/alerts'
import type { Coverage } from '../../domain/provenance'
import type { EvacuationPlanResult } from './routing-service'
import type { RegionRule } from '../../adapters/geo/region'
import { findRegion } from '../../adapters/geo/region'
import {
  describeConfidence,
  isAmbiguous,
  type GeocodeResultSet,
  type GeocodedPlace,
} from '../../domain/geocoding'
import { metresBetween } from '../../lib/geometry/directions'

export interface SummariseFloodOptions {
  /** The mode the run used. An empty result carries no provenance to infer it from. */
  readonly dataMode?: 'live' | 'fixture'
  readonly snapshot: HazardSnapshot
  readonly regionRule: RegionRule
  readonly layerUpdated?: { readonly layerId: string; readonly featureCount: number; readonly vertexCount: number }
}

export interface SummarisePlacesOptions {
  /** The mode the run used. An empty result carries no provenance to infer it from. */
  readonly dataMode?: 'live' | 'fixture'
  readonly facilities: ReadonlyArray<SafeFacility>
  readonly location: ResolvedLocation
  readonly radiusKm: number
  readonly regionRule: RegionRule
  readonly layerUpdated?: { readonly layerId: string; readonly featureCount: number; readonly vertexCount: number }
}

export interface SummariseRoutesOptions {
  /** The mode the run used. An empty result carries no provenance to infer it from. */
  readonly dataMode?: 'live' | 'fixture'
  readonly plan: EvacuationPlanResult
  readonly location: ResolvedLocation
  readonly radiusKm: number
  readonly regionRule: RegionRule
  readonly layerUpdated?: { readonly layerId: string; readonly featureCount: number; readonly vertexCount: number }
}

export interface SummariseAlertsOptions {
  /** The mode the run used. An empty result carries no provenance to infer it from. */
  readonly dataMode?: 'live' | 'fixture'
  readonly alerts: ReadonlyArray<OfficialAlert>
  readonly location: ResolvedLocation
  readonly regionRule: RegionRule
  readonly coverage?: Coverage
  readonly totalCount: number
  readonly expiredCount: number
}

export interface SummariseGeocodeOptions {
  /** The mode the run used. An empty result carries no provenance to infer it from. */
  readonly dataMode?: 'live' | 'fixture'
  readonly result: GeocodeResultSet
  readonly layerUpdated?: { readonly layerId: string; readonly featureCount: number; readonly vertexCount: number }
}

/**
 * How far apart two near-equally-confident matches must be before the tie is worth raising.
 *
 * Below this they are two names for one place — OpenStreetMap holds 福井駅 and 福井 as separate
 * nodes 160 m apart — and every tool downstream works in kilometres, so the choice changes no
 * answer. Reporting it as ambiguous would cost the user a round trip for nothing, and would
 * suppress the next-step line that makes the result usable.
 */
const AMBIGUITY_SEPARATION_METRES = 1000

const ambiguousInPractice = (matches: ReadonlyArray<GeocodedPlace>): boolean => {
  if (!isAmbiguous(matches)) return false
  const [first, second] = matches
  return metresBetween(first!.at, second!.at) > AMBIGUITY_SEPARATION_METRES
}

const MAX_OUTPUT_BYTES = 4096

export const enforce4KbBudget = (text: string): string => {
  if (text.length <= MAX_OUTPUT_BYTES) return text
  const cutIndex = MAX_OUTPUT_BYTES - 120
  return `${text.slice(0, cutIndex)}\n\n[... Remaining details truncated to fit 4 KB local context budget ...]`
}

/**
 * Whether anything in this answer is simulated.
 *
 * This used to be hardcoded true, from when fixtures were the only source there was. Now that the
 * live providers are actually reachable, saying "SIMULATED — NOT REAL" over real data is the same
 * failure as the reverse: a reader who is told everything is a simulation stops reading the
 * warning at all.
 */
export const summariseFlood = (options: SummariseFloodOptions): string => {
  const { snapshot, regionRule, layerUpdated } = options
  const isFixture =
    options.dataMode === 'fixture' || snapshot.zones.some((z) => z.provenance.mode === 'fixture')

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
    // The provider's own sentence first, when there is one. "No flood data covers this location"
    // is true but useless on its own, and it is actively misleading when the real reason is that
    // the run is on recorded data captured hundreds of kilometres away — which is what an empty
    // map at Fukui meant, with a live source that covers it perfectly sitting unused.
    lines.push(
      `Coverage: NONE — ${
        snapshot.coverage.detail ?? 'No flood data covers this location from any configured source.'
      } This is not a statement that there is no flood risk.`,
    )
    return enforce4KbBudget(lines.join('\n'))
  }

  if (snapshot.coverage.state === 'partial') {
    lines.push(
      `Coverage: PARTIAL — ${snapshot.coverage.detail ?? 'Some upstream flood sources failed'}`,
    )
  } else {
    // A provider can be fully covering and still have something to say — that it found nothing
    // mapped in range, or that part of what it found was painted in an unreadable colour.
    lines.push(snapshot.coverage.detail ? `Coverage: FULL — ${snapshot.coverage.detail}` : 'Coverage: FULL')
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
  const isFixture =
    options.dataMode === 'fixture' || facilities.some((f) => f.provenance.mode === 'fixture')

  const lines: Array<string> = []
  lines.push(`SAFE FACILITIES — decision support only. Follow instructions from ${regionRule.authority}.`)
  if (isFixture) {
    lines.push('SIMULATED DATA — NOT REAL (fixture mode)')
  }

  lines.push(
    `Location: ${location.coordinates.latitude.toFixed(3)}, ${location.coordinates.longitude.toFixed(3)} (±${Math.round(location.accuracyMetres)} m, ${location.source}) · radius ${radiusKm.toFixed(1)} km · region ${regionRule.id}`,
  )

  // 3. Provenance line
  const repProv = facilities[0]?.provenance
  if (repProv) {
    const timeStr = new Date(repProv.retrievedAt).toISOString().slice(11, 19) + 'Z'
    const vintageStr = repProv.datasetVintage ? `vintage ${repProv.datasetVintage}` : 'real-time'
    lines.push(`Source: ${repProv.sourceName} · ${vintageStr} · retrieved ${timeStr} · cache ${repProv.cache.hit ? 'hit' : 'miss'}`)
  }

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
  // Routing and hazard data have separate modes, so a plan can be real routes across simulated
  // flood zones. Saying "simulated data" over a real road route, or the reverse, both mislead —
  // and which half is real is exactly what decides whether a reader can act on it.
  const routesAreSimulated =
    plan.routes.length > 0 && plan.routes.every((r) => r.provenance.mode === 'fixture')
  const hazardIsSimulated = options.dataMode === 'fixture'

  const lines: Array<string> = []
  lines.push(`EVACUATION ROUTES — decision support only. Follow instructions from ${regionRule.authority}.`)
  if (hazardIsSimulated && routesAreSimulated) {
    lines.push('SIMULATED DATA — NOT REAL (fixture mode)')
  } else if (hazardIsSimulated) {
    lines.push(
      'SIMULATED shelters and flood zones — NOT REAL. Routes are real, traced on the live road network.',
    )
  } else if (routesAreSimulated) {
    lines.push('Hazard data is live; routes are SIMULATED — do not navigate by them.')
  }

  lines.push(
    `Location: ${location.coordinates.latitude.toFixed(3)}, ${location.coordinates.longitude.toFixed(3)} · costing ${plan.costing} · region ${regionRule.id}`,
  )

  /** Distances to places nothing could be routed to; never a substitute for a route. */
  const describeFallback = (): void => {
    if (!plan.straightLineFallback || plan.straightLineFallback.length === 0) return
    lines.push('\nSTRAIGHT-LINE DISTANCES — NOT ROUTES. These follow no road; do not navigate by them.')
    for (const item of plan.straightLineFallback) {
      const dir = bearingToDirection(item.bearing)
      lines.push(`- ${item.facility.name}: ${item.metres} m ${dir} (Risk: ${item.facility.risk})`)
    }
  }

  if (plan.routes.length === 0) {
    describeFallback()
    lines.push(`Engine note: ${plan.engineNotes}`)
    return enforce4KbBudget(lines.join('\n'))
  }

  if (plan.hasUnavoidedRoutes) {
    lines.push('\nWARNING: route may cross a flood zone — exclusions could not be applied.')
  }

  lines.push(
    `Route candidates on the road network: ${plan.routes.length}, safest first. Route 1 is the recommendation and the one highlighted on the map.`,
  )
  for (let i = 0; i < plan.routes.length; i++) {
    const r = plan.routes[i]!
    const mins = Math.round(r.seconds / 60)
    const crossingNote = r.crossings.assessed
      ? r.crossings.count > 0
        ? `(${r.crossings.count} crossings, first at ${r.crossings.firstAtMetres} m, ${r.crossings.exposedMetres} m through water)`
        : '(no flood crossings)'
      : '(crossings unassessed)'

    lines.push(
      `Route ${i + 1} to ${r.destination.name} [${r.destination.risk.toUpperCase()}]: ${r.metres} m (~${mins} mins) · ${r.exclusions} ${crossingNote}`,
    )
    for (const step of r.steps.slice(0, 3)) {
      lines.push(`   * ${step.instruction} (${step.metres} m)`)
    }
  }

  describeFallback()

  lines.push(`Engine assumptions: ${plan.engineNotes}`)

  if (layerUpdated) {
    lines.push(`Map: layer '${layerUpdated.layerId}' updated (${layerUpdated.featureCount} route lines)`)
  }

  return enforce4KbBudget(lines.join('\n'))
}

export const summariseAlerts = (options: SummariseAlertsOptions): string => {
  const { alerts, location, regionRule, totalCount, expiredCount } = options
  const isFixture =
    options.dataMode === 'fixture' || alerts.some((a) => a.provenance.mode === 'fixture')

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
    // Two different empties. Only one of them means the user is not under a warning, so they must
    // never be printed with the same words (R2.8).
    if (options.coverage?.reason === 'no_data_for_area') {
      lines.push(
        `Official alerts: NO DATA covering this location — this is NOT a report that no warnings are in force.`,
      )
      if (options.coverage.detail) {
        lines.push(options.coverage.detail)
      }
      lines.push(`Check ${regionRule.authority} directly for warnings in effect here.`)
    } else {
      lines.push(`Official alerts: none in force as of ${timeStr} for ${regionRule.name}.`)
    }
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

/**
 * Geocoding results, written so the next tool call is obvious and a wrong one is not.
 *
 * Three things have to survive into the model's context or the answer is unsafe: the coordinates
 * at full precision, whether the match is a point or a region tens of kilometres across, and
 * whether a second candidate was almost as good. The last is the one a summary naturally drops,
 * and it is the one that quietly relocates an evacuation query.
 */
export const summariseGeocode = (options: SummariseGeocodeOptions): string => {
  const { result, layerUpdated } = options
  const isFixture =
    options.dataMode === 'fixture' || result.matches.some((m) => m.provenance.mode === 'fixture')

  const lines: Array<string> = []
  lines.push('PLACE SEARCH — coordinates resolved from a place-name database, not from memory.')
  if (isFixture) {
    lines.push('SIMULATED DATA — NOT REAL (fixture mode)')
  }
  lines.push(`Query: "${result.query}"`)

  const provenance = result.matches[0]?.provenance
  if (provenance) {
    const timeStr = new Date(provenance.retrievedAt).toISOString().slice(11, 19) + 'Z'
    lines.push(
      `Source: ${provenance.sourceName} · ${provenance.attribution} · retrieved ${timeStr} · cache ${provenance.cache.hit ? 'hit' : 'miss'}`,
    )
  }

  if (result.matches.length === 0) {
    lines.push(`No match: ${result.coverage.detail ?? 'nothing matched this name.'}`)
    lines.push(
      'Do not guess coordinates for it. Ask the user to name the town or country as well, or to give coordinates directly.',
    )
    return enforce4KbBudget(lines.join('\n'))
  }

  lines.push(`Matches: ${result.matches.length}`)
  for (const [index, match] of result.matches.entries()) {
    const region = findRegion(match.at)
    const coverageNote = region
      ? `covered (${region.rule.name}, authority ${region.rule.authority})`
      : 'OUTSIDE the covered regions — no flood, shelter or alert data can be returned for it'
    const areaNote =
      match.kind === 'area'
        ? ' — an area, so these coordinates are a label point inside it, not a specific address'
        : ''
    lines.push(
      `${index + 1}. ${match.name} (${match.kind}, ${describeConfidence(match.confidence)} confidence)${areaNote}`,
    )
    lines.push(`   latitude ${match.at.latitude.toFixed(4)}, longitude ${match.at.longitude.toFixed(4)}`)
    lines.push(`   ${match.displayName}`)
    lines.push(`   Region: ${coverageNote}`)
  }

  const ambiguous = ambiguousInPractice(result.matches)
  if (ambiguous) {
    lines.push(
      'AMBIGUOUS: the top two matches answer this name about equally well. Ask which one is meant before acting on either.',
    )
  }

  const best = result.matches[0]
  if (best && ambiguous) {
    // Naming a "next" call here anyway would undo the warning directly above it, which is how a
    // query about one Springfield ends up answered about another.
    lines.push(
      'Next: ask the user which of these places they mean, then pass that one\'s latitude and longitude to disaster.flood_forecast, disaster.find_shelters or disaster.evacuation_routes.',
    )
  } else if (best) {
    lines.push(
      `Next: pass latitude=${best.at.latitude.toFixed(4)} longitude=${best.at.longitude.toFixed(4)} to disaster.flood_forecast, disaster.find_shelters, disaster.evacuation_routes or disaster.official_alerts to ask about this place.`,
    )
  }

  if (layerUpdated) {
    lines.push(`Map: layer '${layerUpdated.layerId}' updated (${layerUpdated.featureCount} points)`)
  }

  return enforce4KbBudget(lines.join('\n'))
}
