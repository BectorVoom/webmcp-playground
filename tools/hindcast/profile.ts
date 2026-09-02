/**
 * Where the over-prediction actually is.
 *
 * Four rounds of work have moved the stage calculation without moving
 * precision, so this asks a different question: not "is the stage right" but
 * "which cells is the model wrong about, and what do they have in common". It
 * slices the false positives three ways — by reported depth, by distance from
 * the surveyed extent, and by the mechanism the route attributes them to.
 *
 *   bun tools/hindcast/profile.ts
 */
import { loadObserved, type Observed } from './observed'
import { EVENTS } from './events'
import { runModel, warmClimatology, type ModelConfig, type ModelRun } from './model'
import {
  buildLattice,
  distanceToMask,
  scoreRun,
  percent,
  meanOf,
  type Lattice,
  type Score,
} from './score'
import { PolygonIndex } from './geometry'

const CELL_AREA_KM2 = 0.01

/** Lower edge of each hazard class, metres — INUNDATION_BANDS in bands.ts. */
const CLASS_FLOOR_M: Record<string, number> = {
  low: 0.05,
  moderate: 0.5,
  high: 3.0,
  extreme: 5.0,
}
const CLASS_ORDER = ['low', 'moderate', 'high', 'extreme'] as const

interface EventProfile {
  readonly site: Observed
  readonly score: Score
  readonly run: ModelRun
  readonly distance: Float32Array
}

const profileEvent = async (site: Observed, lattice: Lattice, config: ModelConfig): Promise<EventProfile> => {
  const run = await runModel(site, config)
  return { site, score: scoreRun(lattice, run), run, distance: distanceToMask(lattice, lattice.observed) }
}

/**
 * Precision if everything below a depth band were left unreported. Free to
 * compute — the zones already carry their band — and it is the cheapest
 * possible lever on precision, so it is worth knowing before anything
 * physical is attempted.
 */
const thresholdSweep = (profiles: ReadonlyArray<EventProfile>, lattices: Map<string, Lattice>): void => {
  console.log('\n## Precision by reported-depth threshold\n')
  console.log('| Keep | mean IoU | mean POD | mean precision | mean model km² |')
  console.log('|---|---|---|---|---|')
  CLASS_ORDER.forEach((floor, floorIndex) => {
    const kept = new Set(CLASS_ORDER.slice(floorIndex))
    const ious: Array<number> = []
    const pods: Array<number> = []
    const precisions: Array<number> = []
    const areas: Array<number> = []
    for (const profile of profiles) {
      const lattice = lattices.get(profile.site.event.id)!
      let tp = 0
      let fp = 0
      let fn = 0
      profile.score.classAt.forEach((hazardClass, i) => {
        const wet = hazardClass !== '' && kept.has(hazardClass as (typeof CLASS_ORDER)[number])
        const truth = lattice.observed[i] === 1
        if (wet && truth) tp++
        else if (wet) fp++
        else if (truth) fn++
      })
      ious.push(tp / (tp + fp + fn || 1))
      pods.push(tp / (tp + fn || 1))
      precisions.push(tp / (tp + fp || 1))
      areas.push((tp + fp) * CELL_AREA_KM2)
    }
    console.log(
      `| ≥ ${CLASS_FLOOR_M[floor]!.toFixed(2)} m (${floor}+) | ${percent(meanOf(ious))} | ` +
        `${percent(meanOf(pods))} | ${percent(meanOf(precisions))} | ${meanOf(areas).toFixed(1)} |`,
    )
  })
}

/** How much of each event's model extent, and its error, sits in each band. */
const bandBreakdown = (profiles: ReadonlyArray<EventProfile>, lattices: Map<string, Lattice>): void => {
  console.log('\n## Model extent by band, and what it is worth\n')
  console.log('| Event | Band | model km² | share | of which correct | band precision |')
  console.log('|---|---|---|---|---|---|')
  for (const profile of profiles) {
    const lattice = lattices.get(profile.site.event.id)!
    const total = profile.score.truePositive + profile.score.falsePositive
    for (const band of CLASS_ORDER) {
      let wet = 0
      let hit = 0
      profile.score.classAt.forEach((hazardClass, i) => {
        if (hazardClass !== band) return
        wet++
        if (lattice.observed[i] === 1) hit++
      })
      if (wet === 0) continue
      console.log(
        `| ${profile.site.event.id} | ${band} | ${(wet * CELL_AREA_KM2).toFixed(2)} | ` +
          `${percent(wet / total)} | ${(hit * CELL_AREA_KM2).toFixed(2)} | ${percent(hit / wet)} |`,
      )
    }
  }
}

const DISTANCE_BINS = [100, 300, 1000, 3000, Infinity]

/** Is the over-prediction a fringe around the real flood, or somewhere else? */
const distanceBreakdown = (profiles: ReadonlyArray<EventProfile>): void => {
  console.log('\n## False positives by distance from the surveyed extent\n')
  console.log('| Event | ≤100 m | ≤300 m | ≤1 km | ≤3 km | >3 km | FP km² |')
  console.log('|---|---|---|---|---|---|---|')
  for (const profile of profiles) {
    const counts = new Array(DISTANCE_BINS.length).fill(0)
    let total = 0
    profile.score.classAt.forEach((hazardClass, i) => {
      if (hazardClass === '') return
      if (profile.distance[i] === 0) return
      total++
      const bin = DISTANCE_BINS.findIndex((edge) => profile.distance[i]! <= edge)
      counts[bin]++
    })
    const shares = counts.map((count) => percent(count / (total || 1)))
    console.log(
      `| ${profile.site.event.id} | ${shares.join(' | ')} | ${(total * CELL_AREA_KM2).toFixed(1)} |`,
    )
  }
}

/** What the route itself says each mechanism contributed, over the whole circle. */
const mechanismAreas = (profiles: ReadonlyArray<EventProfile>): void => {
  console.log('\n## Mechanism attribution, as the route reports it (whole 20 km circle)\n')
  console.log('| Event | total km² | pluvial-only km² | fluvial-only km² | fluvial adds | levee saved | p99 depth |')
  console.log('|---|---|---|---|---|---|---|')
  for (const profile of profiles) {
    const inundation = profile.run.response.inundation as Record<string, unknown>
    const attribution = inundation.attribution as Record<string, number>
    console.log(
      `| ${profile.site.event.id} | ${(inundation.floodedAreaKm2 as number).toFixed(1)} | ` +
        `${attribution.pluvialOnlyAreaKm2!.toFixed(1)} | ${attribution.fluvialOnlyAreaKm2!.toFixed(1)} | ` +
        `${attribution.fluvialDeltaAreaKm2!.toFixed(1)} | ${attribution.leveeProtectedAreaKm2!.toFixed(1)} | ` +
        `${(inundation.p99DepthMetres as number).toFixed(2)} m |`,
    )
  }
}

type BandStats = Record<string, { wet: number; hit: number }>

/**
 * Precision band by band for one field. The combined extent already shows that
 * the deeper the model says, the more often it is wrong; this says which of the
 * two mechanisms that indictment belongs to.
 */
const bandPrecision = (index: PolygonIndex, lattice: Lattice): BandStats => {
  const stats: BandStats = {}
  for (const band of CLASS_ORDER) stats[band] = { wet: 0, hit: 0 }
  lattice.points.forEach((point, i) => {
    const band = index.tagAt(point.longitude, point.latitude)
    if (band === null || !(band in stats)) return
    stats[band]!.wet++
    if (lattice.observed[i] === 1) stats[band]!.hit++
  })
  return stats
}

/**
 * The same split, but inside the scored window and against the survey — which
 * is the form that says which mechanism the precision problem belongs to. The
 * areas above cover a 1 257 km² circle against a district-scale survey, so they
 * cannot answer that on their own.
 */
const mechanismScores = (profiles: ReadonlyArray<EventProfile>, lattices: Map<string, Lattice>): void => {
  console.log('\n## Each mechanism scored on its own, inside the surveyed footprint\n')
  console.log('| Event | Field | wet km² | TP km² | FP km² | POD | precision |')
  console.log('|---|---|---|---|---|---|---|')
  const bandsByMechanism: Array<{ event: string; pluvial: BandStats; fluvial: BandStats }> = []
  const rows: Array<{ event: string; pluvialOnly: number; fluvialOnly: number; both: number; fpTotal: number; tpPluvialOnly: number; tpFluvialOnly: number; tpBoth: number }> = []

  for (const profile of profiles) {
    const lattice = lattices.get(profile.site.event.id)!
    const { pluvial, fluvial } = profile.run
    if (!pluvial || !fluvial) throw new Error('run without componentZones: nothing to attribute')
    const pluvialIndex = new PolygonIndex(pluvial.polygons, pluvial.classes)
    const fluvialIndex = new PolygonIndex(fluvial.polygons, fluvial.classes)

    const wetPluvial: Array<boolean> = []
    const wetFluvial: Array<boolean> = []
    lattice.points.forEach((point) => {
      wetPluvial.push(pluvialIndex.contains(point.longitude, point.latitude))
      wetFluvial.push(fluvialIndex.contains(point.longitude, point.latitude))
    })

    const report = (label: string, wet: ReadonlyArray<boolean>): void => {
      let tp = 0
      let fp = 0
      let fn = 0
      wet.forEach((isWet, i) => {
        const truth = lattice.observed[i] === 1
        if (isWet && truth) tp++
        else if (isWet) fp++
        else if (truth) fn++
      })
      console.log(
        `| ${profile.site.event.id} | ${label} | ${((tp + fp) * CELL_AREA_KM2).toFixed(1)} | ` +
          `${(tp * CELL_AREA_KM2).toFixed(1)} | ${(fp * CELL_AREA_KM2).toFixed(1)} | ` +
          `${percent(tp / (tp + fn || 1))} | ${percent(tp / (tp + fp || 1))} |`,
      )
    }
    report('pluvial', wetPluvial)
    report('fluvial', wetFluvial)
    report('reported', profile.score.classAt.map((c) => c !== ''))
    bandsByMechanism.push({
      event: profile.site.event.id,
      pluvial: bandPrecision(pluvialIndex, lattice),
      fluvial: bandPrecision(fluvialIndex, lattice),
    })

    let pluvialOnly = 0
    let fluvialOnly = 0
    let both = 0
    let fpTotal = 0
    let tpPluvialOnly = 0
    let tpFluvialOnly = 0
    let tpBoth = 0
    profile.score.classAt.forEach((hazardClass, i) => {
      if (hazardClass === '') return
      const truth = lattice.observed[i] === 1
      const p = wetPluvial[i]!
      const f = wetFluvial[i]!
      if (truth) {
        if (p && f) tpBoth++
        else if (p) tpPluvialOnly++
        else if (f) tpFluvialOnly++
        return
      }
      fpTotal++
      if (p && f) both++
      else if (p) pluvialOnly++
      else if (f) fluvialOnly++
    })
    rows.push({ event: profile.site.event.id, pluvialOnly, fluvialOnly, both, fpTotal, tpPluvialOnly, tpFluvialOnly, tpBoth })
  }

  console.log('\n### Depth band by mechanism — where the deep wrong water comes from\n')
  console.log('| Event | Field | low km² / prec | moderate | high | extreme |')
  console.log('|---|---|---|---|---|---|')
  for (const row of bandsByMechanism) {
    for (const field of ['pluvial', 'fluvial'] as const) {
      const stats = row[field]
      const cells = CLASS_ORDER.map((band) => {
        const { wet, hit } = stats[band]!
        return wet === 0 ? '—' : `${(wet * CELL_AREA_KM2).toFixed(1)} / ${percent(hit / wet)}`
      })
      console.log(`| ${row.event} | ${field} | ${cells.join(' | ')} |`)
    }
  }

  console.log('\n### Who owns the error\n')
  console.log('| Event | FP km² | pluvial alone | fluvial alone | both | TP km² | pluvial alone | fluvial alone | both |')
  console.log('|---|---|---|---|---|---|---|---|---|')
  for (const row of rows) {
    const tpTotal = row.tpPluvialOnly + row.tpFluvialOnly + row.tpBoth
    console.log(
      `| ${row.event} | ${(row.fpTotal * CELL_AREA_KM2).toFixed(1)} | ${percent(row.pluvialOnly / (row.fpTotal || 1))} | ` +
        `${percent(row.fluvialOnly / (row.fpTotal || 1))} | ${percent(row.both / (row.fpTotal || 1))} | ` +
        `${(tpTotal * CELL_AREA_KM2).toFixed(1)} | ${percent(row.tpPluvialOnly / (tpTotal || 1))} | ` +
        `${percent(row.tpFluvialOnly / (tpTotal || 1))} | ${percent(row.tpBoth / (tpTotal || 1))} |`,
    )
  }
}

/**
 * The fluvial error split by whether the reach under it solved its rating curve
 * or ran off the end of the stage ladder. A pegged reach stands at 20 m because
 * nothing smaller passed its discharge — a failure mode, not an estimate — and
 * every site's stage max reads 20 m, so the question is how much of the extent
 * and of the error that failure owns.
 */
const peggedAttribution = (profiles: ReadonlyArray<EventProfile>, lattices: Map<string, Lattice>): void => {
  console.log('\n## Fluvial water by whether its reach solved the ladder or pegged\n')
  console.log('| Event | Field | wet km² | TP km² | FP km² | precision | share of fluvial FP |')
  console.log('|---|---|---|---|---|---|---|')
  for (const profile of profiles) {
    const lattice = lattices.get(profile.site.event.id)!
    const { fluvial, fluvialPegged } = profile.run
    if (!fluvial || !fluvialPegged) throw new Error('run without fluvialPeggedZones: refresh the run cache')
    const fluvialIndex = new PolygonIndex(fluvial.polygons, fluvial.classes)
    const peggedIndex = new PolygonIndex(fluvialPegged.polygons, fluvialPegged.classes)

    let fluvialFp = 0
    const tally = { pegged: { wet: 0, tp: 0 }, solved: { wet: 0, tp: 0 } }
    lattice.points.forEach((point, i) => {
      if (!fluvialIndex.contains(point.longitude, point.latitude)) return
      const truth = lattice.observed[i] === 1
      if (!truth) fluvialFp++
      const bucket = peggedIndex.contains(point.longitude, point.latitude) ? tally.pegged : tally.solved
      bucket.wet++
      if (truth) bucket.tp++
    })

    for (const field of ['pegged', 'solved'] as const) {
      const { wet, tp } = tally[field]
      const fp = wet - tp
      console.log(
        `| ${profile.site.event.id} | ${field} | ${(wet * CELL_AREA_KM2).toFixed(1)} | ` +
          `${(tp * CELL_AREA_KM2).toFixed(1)} | ${(fp * CELL_AREA_KM2).toFixed(1)} | ` +
          `${percent(tp / (wet || 1))} | ${percent(fp / (fluvialFp || 1))} |`,
      )
    }
  }
}

const diagnostics = (profiles: ReadonlyArray<EventProfile>): void => {
  console.log('\n## Network diagnostics\n')
  console.log('| Event | channel km | max drainage km² | trunk bankfull | pegged | defended | embankment ways | stage max |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const profile of profiles) {
    const network = profile.run.response.network as Record<string, unknown>
    const method = profile.run.response.method as Record<string, unknown>
    const defences = profile.run.response.defences as Record<string, unknown>
    console.log(
      `| ${profile.site.event.id} | ${network.approxChannelLengthKm} | ${network.maxDrainageAreaKm2} | ` +
        `${network.trunkBankfullM3PerS} m³/s | ${network.reachesStagePegged} | ${network.reachesDefended} | ` +
        `${defences.embankmentWays} | ${method.maxRiverStageM} m |`,
    )
  }
}

const main = async (): Promise<void> => {
  const sites = await Promise.all(EVENTS.map(loadObserved))
  const lattices = new Map(sites.map((site) => [site.event.id, buildLattice(site)]))
  await warmClimatology(sites)

  const profiles: Array<EventProfile> = []
  for (const site of sites) {
    profiles.push(await profileEvent(site, lattices.get(site.event.id)!, { componentZones: true }))
  }

  console.log('# Precision profile — baseline configuration\n')
  console.log('| Event | IoU | POD | Precision | scored model km² | scored observed km² |')
  console.log('|---|---|---|---|---|---|')
  for (const { site, score } of profiles) {
    console.log(
      `| ${site.event.id} | ${percent(score.iou)} | ${percent(score.pod)} | ${percent(score.precision)} | ` +
        `${score.modelAreaKm2.toFixed(1)} | ${score.observedAreaKm2.toFixed(1)} |`,
    )
  }

  bandBreakdown(profiles, lattices)
  thresholdSweep(profiles, lattices)
  distanceBreakdown(profiles)
  mechanismAreas(profiles)
  mechanismScores(profiles, lattices)
  peggedAttribution(profiles, lattices)
  diagnostics(profiles)
}

if (import.meta.main) {
  await main()
}
