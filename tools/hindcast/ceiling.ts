/**
 * How good can HAND on this terrain be, at best?
 *
 * Every round of accuracy work so far has changed how the stage is chosen. This
 * asks whether that is the binding constraint at all: stand every river at one
 * height, sweep the height, and score. The best row is the ceiling on any model
 * that maps extent as "below the river's water surface, by HAND" on this DEM —
 * no rating curve can beat a stage chosen with hindsight.
 *
 * If the ceiling is near the shipped score, the stage is not what is wrong.
 *
 *   bun tools/hindcast/ceiling.ts
 */
import { EVENTS } from './events'
import { loadObserved } from './observed'
import { runModel, warmClimatology } from './model'
import { buildLattice, percent, meanOf, type Lattice } from './score'
import { PolygonIndex } from './geometry'

const STAGES = [0.5, 1, 1.5, 2, 3, 4, 5, 7, 10]

interface Metrics {
  readonly iou: number
  readonly pod: number
  readonly precision: number
  readonly wetKm2: number
}

const scoreField = (lattice: Lattice, index: PolygonIndex): Metrics => {
  let tp = 0
  let fp = 0
  let fn = 0
  lattice.points.forEach((point, i) => {
    const wet = index.contains(point.longitude, point.latitude)
    const truth = lattice.observed[i] === 1
    if (wet && truth) tp++
    else if (wet) fp++
    else if (truth) fn++
  })
  return {
    iou: tp / (tp + fp + fn || 1),
    pod: tp / (tp + fn || 1),
    precision: tp / (tp + fp || 1),
    wetKm2: (tp + fp) * 0.01,
  }
}

const main = async (): Promise<void> => {
  const sites = await Promise.all(EVENTS.map(loadObserved))
  await warmClimatology(sites)
  const lattices = new Map(sites.map((site) => [site.event.id, buildLattice(site)]))

  console.log('# Ceiling of HAND mapping — one stage everywhere, swept\n')
  console.log('Fluvial field only, scored inside the surveyed footprint.\n')
  console.log('| Stage | ' + sites.map((s) => `${s.event.id} IoU / POD / prec`).join(' | ') + ' | mean IoU |')
  console.log('|---|' + sites.map(() => '---|').join('') + '---|')

  const best = new Map<string, { stage: number; metrics: Metrics }>()
  for (const stage of STAGES) {
    const cells: Array<string> = []
    const ious: Array<number> = []
    for (const site of sites) {
      const run = await runModel(site, { componentZones: true, uniformStageM: stage })
      if (!run.fluvial) throw new Error('no component zones')
      const metrics = scoreField(
        lattices.get(site.event.id)!,
        new PolygonIndex(run.fluvial.polygons, run.fluvial.classes),
      )
      ious.push(metrics.iou)
      cells.push(`${percent(metrics.iou)} / ${percent(metrics.pod)} / ${percent(metrics.precision)}`)
      const current = best.get(site.event.id)
      if (!current || metrics.iou > current.metrics.iou) best.set(site.event.id, { stage, metrics })
    }
    console.log(`| ${stage} m | ${cells.join(' | ')} | ${percent(meanOf(ious))} |`)
  }

  console.log('\n## Best stage per site — the ceiling, chosen with hindsight\n')
  console.log('| Event | best stage | IoU | POD | precision | wet km² | shipped IoU |')
  console.log('|---|---|---|---|---|---|---|')
  const shipped: Record<string, number> = { joso: 0.163, mabi: 0.161, nagano: 0.107, kuma: 0.24 }
  for (const site of sites) {
    const entry = best.get(site.event.id)!
    console.log(
      `| ${site.event.id} | ${entry.stage} m | **${percent(entry.metrics.iou)}** | ` +
        `${percent(entry.metrics.pod)} | ${percent(entry.metrics.precision)} | ` +
        `${entry.metrics.wetKm2.toFixed(1)} | ${percent(shipped[site.event.id]!)} |`,
    )
  }
  console.log(
    `\nMean ceiling IoU: **${percent(meanOf([...best.values()].map((b) => b.metrics.iou)))}** ` +
      'against a shipped mean of 16.8%.',
  )
}

if (import.meta.main) {
  await main()
}
