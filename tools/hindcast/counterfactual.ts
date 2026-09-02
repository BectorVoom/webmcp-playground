/**
 * What would the score be if the reported extent were filtered?
 *
 * The profile says the model's deep water is its least accurate water, and that
 * most of the deep-and-wrong water is pluvial ponding. These rules test that
 * reading without changing the model: each one re-derives the reported extent
 * from the two component fields, which are already on disk, so a rule costs
 * seconds rather than a run.
 *
 * A rule that wins here is a hypothesis worth implementing, not a result. It is
 * measured on the same four events the defaults were set by, and this model's
 * history is that plausible changes do nothing — so the rule that survives here
 * still has to survive being built properly.
 *
 *   bun tools/hindcast/counterfactual.ts
 */
import { EVENTS } from './events'
import { loadObserved } from './observed'
import { runModel, warmClimatology } from './model'
import { buildLattice, percent, meanOf, type Lattice } from './score'
import { PolygonIndex } from './geometry'

const BAND_RANK: Record<string, number> = { '': 0, low: 1, moderate: 2, high: 3, extreme: 4 }

/** Per-lattice-point band rank for each field of one event. */
interface Fields {
  readonly id: string
  readonly lattice: Lattice
  readonly pluvial: Uint8Array
  readonly fluvial: Uint8Array
  readonly reported: Uint8Array
}

/**
 * Connected pluvial ponds on the lattice, and the deepest band each reaches.
 *
 * A closed depression that fills to more than a few metres in a 60-90 m DEM is
 * usually an unresolved culvert or a road embankment rather than a lake, and
 * the artifact is the whole pond, not the deep part of it — so the rules that
 * discard one have to discard all of it.
 */
const pondMaxBand = (fields: Fields): Uint8Array => {
  const { lattice, pluvial } = fields
  const { rows, cols, cellIndex } = lattice
  const maxBand = new Uint8Array(pluvial.length)
  const seen = new Uint8Array(pluvial.length)
  const stack: Array<number> = []

  for (let start = 0; start < pluvial.length; start++) {
    if (seen[start] || pluvial[start] === 0) continue
    const members: Array<number> = []
    let deepest = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length > 0) {
      const point = stack.pop()!
      members.push(point)
      if (pluvial[point]! > deepest) deepest = pluvial[point]!
      const cell = lattice.cellOf[point]!
      const row = Math.floor(cell / cols)
      const col = cell % cols
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const r = row + dr
        const c = col + dc
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue
        const neighbour = cellIndex[r * cols + c]!
        if (neighbour < 0 || seen[neighbour] || pluvial[neighbour] === 0) continue
        seen[neighbour] = 1
        stack.push(neighbour)
      }
    }
    for (const member of members) maxBand[member] = deepest
  }
  return maxBand
}

interface Rule {
  readonly name: string
  readonly describe: string
  readonly wet: (fields: Fields, ponds: Uint8Array, i: number) => boolean
}

const RULES: ReadonlyArray<Rule> = [
  {
    name: 'baseline',
    describe: 'as shipped: the deeper of the two fields, everything ≥ 5 cm',
    wet: (f, _p, i) => f.reported[i]! > 0,
  },
  {
    name: 'no-pluvial',
    describe: 'river stage only — the pluvial field discarded entirely',
    wet: (f, _p, i) => f.fluvial[i]! > 0,
  },
  {
    name: 'no-fluvial',
    describe: 'rain ponding only — the river stage discarded entirely',
    wet: (f, _p, i) => f.pluvial[i]! > 0,
  },
  {
    name: 'pluvial-cell<3m',
    describe: 'pluvial cells deeper than 3 m dropped, cell by cell',
    wet: (f, _p, i) => f.fluvial[i]! > 0 || (f.pluvial[i]! > 0 && f.pluvial[i]! < BAND_RANK.high!),
  },
  {
    name: 'pluvial-pond<3m',
    describe: 'whole pluvial ponds discarded where the pond reaches 3 m',
    wet: (f, p, i) => f.fluvial[i]! > 0 || (f.pluvial[i]! > 0 && p[i]! < BAND_RANK.high!),
  },
  {
    name: 'pluvial-pond<5m',
    describe: 'whole pluvial ponds discarded where the pond reaches 5 m',
    wet: (f, p, i) => f.fluvial[i]! > 0 || (f.pluvial[i]! > 0 && p[i]! < BAND_RANK.extreme!),
  },
  {
    name: 'fluvial-cell<3m',
    describe: 'river cells deeper than 3 m dropped, cell by cell',
    wet: (f, _p, i) => f.pluvial[i]! > 0 || (f.fluvial[i]! > 0 && f.fluvial[i]! < BAND_RANK.high!),
  },
  {
    name: 'both-pond<3m',
    describe: 'deep pluvial ponds and deep river cells both dropped',
    wet: (f, p, i) =>
      (f.fluvial[i]! > 0 && f.fluvial[i]! < BAND_RANK.high!) ||
      (f.pluvial[i]! > 0 && p[i]! < BAND_RANK.high!),
  },
]

const main = async (): Promise<void> => {
  const sites = await Promise.all(EVENTS.map(loadObserved))
  await warmClimatology(sites)

  const all: Array<Fields> = []
  const ponds: Array<Uint8Array> = []
  for (const site of sites) {
    const lattice = buildLattice(site)
    const run = await runModel(site, { componentZones: true })
    if (!run.pluvial || !run.fluvial) throw new Error('run without componentZones')
    const rank = (index: PolygonIndex): Uint8Array => {
      const out = new Uint8Array(lattice.points.length)
      lattice.points.forEach((point, i) => {
        out[i] = BAND_RANK[index.tagAt(point.longitude, point.latitude) ?? ''] ?? 0
      })
      return out
    }
    const fields: Fields = {
      id: site.event.id,
      lattice,
      pluvial: rank(new PolygonIndex(run.pluvial.polygons, run.pluvial.classes)),
      fluvial: rank(new PolygonIndex(run.fluvial.polygons, run.fluvial.classes)),
      reported: rank(new PolygonIndex(run.polygons, run.classes)),
    }
    all.push(fields)
    ponds.push(pondMaxBand(fields))
  }

  console.log('# Counterfactual filters on the reported extent\n')
  console.log('| Rule | mean IoU | mean POD | mean precision | ' + sites.map((s) => s.event.id).join(' IoU | ') + ' IoU |')
  console.log('|---|---|---|---|' + sites.map(() => '---|').join(''))
  for (const rule of RULES) {
    const ious: Array<number> = []
    const pods: Array<number> = []
    const precisions: Array<number> = []
    all.forEach((fields, index) => {
      let tp = 0
      let fp = 0
      let fn = 0
      for (let i = 0; i < fields.lattice.points.length; i++) {
        const wet = rule.wet(fields, ponds[index]!, i)
        const truth = fields.lattice.observed[i] === 1
        if (wet && truth) tp++
        else if (wet) fp++
        else if (truth) fn++
      }
      ious.push(tp / (tp + fp + fn || 1))
      pods.push(tp / (tp + fn || 1))
      precisions.push(tp / (tp + fp || 1))
    })
    console.log(
      `| ${rule.name} | ${percent(meanOf(ious))} | ${percent(meanOf(pods))} | ` +
        `${percent(meanOf(precisions))} | ${ious.map(percent).join(' | ')} |`,
    )
  }
  console.log('')
  for (const rule of RULES) console.log(`- **${rule.name}** — ${rule.describe}`)
}

if (import.meta.main) {
  await main()
}
