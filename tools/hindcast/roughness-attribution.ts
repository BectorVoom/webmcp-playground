/**
 * Raising Manning's n improves the score — but n is one number applied to the
 * channel and the floodplain alike, so the gain could be the intended one (a
 * rougher floodplain conveys less, so the rating curve needs a higher stage) or
 * an incidental one (a rougher channel carries less, so more rain ponds).
 * Knowing which decides what to build.
 *
 *   bun tools/hindcast/roughness-attribution.ts
 */
import { EVENTS } from './events'
import { loadObserved } from './observed'
import { runModel, warmClimatology } from './model'
import { buildLattice, percent, meanOf, type Lattice } from './score'
import { PolygonIndex } from './geometry'

const score = (lattice: Lattice, index: PolygonIndex) => {
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
  return { iou: tp / (tp + fp + fn || 1), pod: tp / (tp + fn || 1), wetKm2: (tp + fp) * 0.01 }
}

const main = async (): Promise<void> => {
  const sites = await Promise.all(EVENTS.map(loadObserved))
  await warmClimatology(sites)

  console.log('# Where the roughness gain comes from\n')
  console.log('| Event | Field | n=0.035 wet km² | n=0.10 wet km² | Δ | n=0.035 IoU | n=0.10 IoU |')
  console.log('|---|---|---|---|---|---|---|')
  const gains: Record<string, Array<number>> = { pluvial: [], fluvial: [] }

  for (const site of sites) {
    const lattice = buildLattice(site)
    const base = await runModel(site, { componentZones: true })
    const rough = await runModel(site, { componentZones: true, manningN: 0.1 })
    for (const field of ['pluvial', 'fluvial'] as const) {
      const a = base[field]!
      const b = rough[field]!
      const sa = score(lattice, new PolygonIndex(a.polygons, a.classes))
      const sb = score(lattice, new PolygonIndex(b.polygons, b.classes))
      gains[field]!.push(sb.iou - sa.iou)
      console.log(
        `| ${site.event.id} | ${field} | ${sa.wetKm2.toFixed(1)} | ${sb.wetKm2.toFixed(1)} | ` +
          `${(sb.wetKm2 - sa.wetKm2 >= 0 ? '+' : '')}${(sb.wetKm2 - sa.wetKm2).toFixed(1)} | ` +
          `${percent(sa.iou)} | ${percent(sb.iou)} |`,
      )
    }
  }
  console.log(
    `\nMean IoU change: pluvial field ${(meanOf(gains.pluvial!) * 100).toFixed(1)} points, ` +
      `fluvial field ${(meanOf(gains.fluvial!) * 100).toFixed(1)} points.`,
  )
}

if (import.meta.main) {
  await main()
}
