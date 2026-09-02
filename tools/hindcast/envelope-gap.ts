/**
 * Why do Kuma and Nagano trail Joso against the official envelope?
 *
 * Round ten left precision at 81.3% (Joso), 69.9% (Mabi), 62.2% (Nagano) and
 * 59.5% (Kuma) and read that spread as three sites the model handles worse.
 * That reading assumes precision is comparable across the four windows, and it
 * is not: **precision depends on how much of the window is wet to begin with.**
 * A predictor that fires at random scores its site's base rate, and the base
 * rates here run from 55% at Joso to 14% at Kuma. The ranking may be measuring
 * the windows rather than the model.
 *
 * Three hypotheses, each with its own falsifier:
 *
 *   H1 base rate    Precision tracks prevalence. Falsified if prevalence-free
 *                   skill (lift, MCC, informedness) keeps the same ranking.
 *   H2 coverage     Nagano is charged for ground nobody assessed: 30 of its 84
 *                   hazard tiles carry no designation at all. Falsified if
 *                   restricting the score to designated ground barely moves it.
 *   H3 geometry     A narrow target punishes a near-miss. Falsified if the
 *                   trailing sites' wrong cells sit far from the envelope
 *                   rather than hugging its edge.
 *
 *   bun tools/hindcast/envelope-gap.ts [config...]
 */
import { EVENTS } from './events'
import { loadObserved } from './observed'
import { runModel, warmClimatology } from './model'
import { buildLattice, scoreRun, distanceToMask, percent, meanOf, type Lattice } from './score'
import { CONFIGS } from './run'
import { loadHazardMask, type HazardMask } from './hazard'

const CELL_AREA_KM2 = 0.01

interface Skill {
  readonly tp: number
  readonly fp: number
  readonly fn: number
  readonly tn: number
  readonly precision: number
  readonly pod: number
  /** Share of the scored window that is wet in the truth — what a coin would score. */
  readonly prevalence: number
  /** Precision over prevalence: how many times better than firing at random. */
  readonly lift: number
  /** Youden's J = POD + specificity - 1. 0 is chance at any prevalence. */
  readonly informedness: number
  /** Matthews correlation. The prevalence-robust single number. */
  readonly mcc: number
}

/**
 * Scores `predicted` against `truth`, counting only points where `scored` is 1.
 * The mask is what lets ground nobody assessed be left out rather than assumed
 * dry.
 */
const skillOf = (predicted: Uint8Array, truth: Uint8Array, scored?: Uint8Array): Skill => {
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  for (let i = 0; i < predicted.length; i++) {
    if (scored && scored[i] !== 1) continue
    const wet = predicted[i] === 1
    const real = truth[i] === 1
    if (wet && real) tp++
    else if (wet) fp++
    else if (real) fn++
    else tn++
  }
  const total = tp + fp + fn + tn
  const precision = tp / (tp + fp || 1)
  const pod = tp / (tp + fn || 1)
  const specificity = tn / (tn + fp || 1)
  const prevalence = (tp + fn) / (total || 1)
  const denominator = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
  return {
    tp,
    fp,
    fn,
    tn,
    precision,
    pod,
    prevalence,
    lift: prevalence > 0 ? precision / prevalence : NaN,
    informedness: pod + specificity - 1,
    mcc: denominator > 0 ? (tp * tn - fp * fn) / denominator : 0,
  }
}

const DISTANCE_BINS = [0, 100, 300, 1000, 3000, Infinity] as const

const main = async (): Promise<void> => {
  const sites = await Promise.all(EVENTS.map(loadObserved))
  await warmClimatology(sites)
  const lattices = new Map<string, Lattice>(sites.map((s) => [s.event.id, buildLattice(s)]))
  const hazards = new Map<string, HazardMask>()
  for (const site of sites) {
    hazards.set(site.event.id, await loadHazardMask(lattices.get(site.event.id)!.points))
  }

  const names = process.argv.slice(2).length ? process.argv.slice(2) : ['gsi10']

  console.log('# Why Kuma and Nagano trail Joso against the official envelope\n')

  for (const name of names) {
    const config = CONFIGS[name]
    if (!config) throw new Error(`unknown config: ${name} (have ${Object.keys(CONFIGS).join(', ')})`)

    const wetOf = new Map<string, Uint8Array>()
    for (const site of sites) {
      const run = await runModel(site, config)
      const scored = scoreRun(lattices.get(site.event.id)!, run)
      wetOf.set(site.event.id, Uint8Array.from(scored.classAt, (cls) => (cls === '' ? 0 : 1)))
    }

    // ---- H1: is the ranking just the base rate? -------------------------
    console.log(`## H1 — Precision against what a coin would score (\`${name}\`)\n`)
    console.log(
      '`prevalence` is the envelope share of the scored window: what a predictor that fires\n' +
        'at random would score. `lift` is precision over that. MCC and informedness are 0 at\n' +
        'chance whatever the prevalence.\n',
    )
    console.log('| Event | prevalence | precision | **lift** | informedness | MCC |')
    console.log('|---|---|---|---|---|---|')
    const skills = new Map<string, Skill>()
    for (const site of sites) {
      const s = skillOf(wetOf.get(site.event.id)!, hazards.get(site.event.id)!.wet)
      skills.set(site.event.id, s)
      console.log(
        `| ${site.event.id} | ${percent(s.prevalence)} | ${percent(s.precision)} | ` +
          `**${s.lift.toFixed(2)}x** | ${s.informedness.toFixed(3)} | ${s.mcc.toFixed(3)} |`,
      )
    }
    const byLift = [...skills.entries()].sort((a, b) => b[1].lift - a[1].lift)
    const byPrecision = [...skills.entries()].sort((a, b) => b[1].precision - a[1].precision)
    console.log(
      `\nRanked by precision: ${byPrecision.map(([id]) => id).join(' > ')}` +
        `\nRanked by lift:      ${byLift.map(([id]) => id).join(' > ')}`,
    )

    // ---- H2: is the reference charging for unassessed ground? -----------
    console.log(`\n## H2 — Scoring only where the envelope is authoritative (\`${name}\`)\n`)
    console.log(
      'A tile the portal does not serve means no river assumption area reaches that ground.\n' +
        'That is not mapped, not known-dry. Dropping it scores the model only where the\n' +
        'reference actually has an opinion.\n',
    )
    console.log('| Event | window km² | undesignated | precision (all) | precision (designated only) | Δ |')
    console.log('|---|---|---|---|---|---|')
    for (const site of sites) {
      const hazard = hazards.get(site.event.id)!
      const wet = wetOf.get(site.event.id)!
      const all = skills.get(site.event.id)!
      const restricted = skillOf(wet, hazard.wet, hazard.designated)
      const undesignated = hazard.coverage.pointsNotDesignated / hazard.coverage.pointsTotal
      const delta = restricted.precision - all.precision
      console.log(
        `| ${site.event.id} | ${(hazard.coverage.pointsTotal * CELL_AREA_KM2).toFixed(1)} | ` +
          `${percent(undesignated)} | ${percent(all.precision)} | ` +
          `**${percent(restricted.precision)}** | ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} |`,
      )
    }

    // ---- H3: are the wrong cells near the envelope or elsewhere? --------
    console.log(`\n## H3 — How far the wrong cells sit from the envelope (\`${name}\`)\n`)
    console.log(
      'A narrow target punishes a near-miss twice: the cell is wrong, and the cell it should\n' +
        'have been is small. If the trailing sites\' errors hug the boundary the model is\n' +
        'nearly right; if they are kilometres away it is wrong somewhere else.\n',
    )
    console.log('| Event | FP km² | ≤100 m | ≤300 m | ≤1 km | ≤3 km | >3 km | envelope thinness |')
    console.log('|---|---|---|---|---|---|---|---|')
    for (const site of sites) {
      const lattice = lattices.get(site.event.id)!
      const hazard = hazards.get(site.event.id)!
      const wet = wetOf.get(site.event.id)!
      const toEnvelope = distanceToMask(lattice, hazard.wet)

      const counts = new Array(DISTANCE_BINS.length - 1).fill(0)
      let fp = 0
      for (let i = 0; i < wet.length; i++) {
        if (wet[i] !== 1 || hazard.wet[i] === 1) continue
        fp++
        for (let b = 1; b < DISTANCE_BINS.length; b++) {
          if (toEnvelope[i]! <= DISTANCE_BINS[b]!) {
            counts[b - 1]++
            break
          }
        }
      }

      // Thinness: mean distance from an envelope cell to the nearest cell
      // outside it. A wide floodplain scores high; a ribbon in a gorge low.
      const outside = Uint8Array.from(hazard.wet, (v) => (v === 1 ? 0 : 1))
      const toEdge = distanceToMask(lattice, outside)
      let sum = 0
      let n = 0
      for (let i = 0; i < hazard.wet.length; i++) {
        if (hazard.wet[i] !== 1) continue
        sum += toEdge[i]!
        n++
      }
      const thinness = n > 0 ? sum / n : NaN

      console.log(
        `| ${site.event.id} | ${(fp * CELL_AREA_KM2).toFixed(1)} | ` +
          counts.map((c) => percent(c / (fp || 1))).join(' | ') +
          ` | ${thinness.toFixed(0)} m |`,
      )
    }

    // ---- H3, priced: what does a near-miss actually cost per site? ------
    //
    // Thinness is a proxy; this is the quantity. Take the envelope itself —
    // a perfect answer — displace it by one and two lattice cells, and score it
    // against the truth it came from. That is the precision ceiling for a model
    // that has the shape exactly right and the position off by 100 m, and it
    // depends only on the target's geometry, never on our model.
    console.log(`\n## H3 priced — the ceiling for a perfect answer displaced by 100 m / 200 m\n`)
    console.log(
      'The last column is the one that matters: our precision as a share of what a flawless\n' +
        'answer could score on that site\'s geometry. It is the comparison the raw precision\n' +
        'column was never entitled to make.\n',
    )
    console.log(
      '| Event | perfect | off by 100 m | off by 200 m | our precision | **% of 100 m ceiling** |',
    )
    console.log('|---|---|---|---|---|---|')
    const ofCeiling: Array<[string, number]> = []
    for (const site of sites) {
      const lattice = lattices.get(site.event.id)!
      const hazard = hazards.get(site.event.id)!
      const shiftedPrecision = (cells: number): number => {
        const shifted = new Uint8Array(hazard.wet.length)
        for (let point = 0; point < hazard.wet.length; point++) {
          const slot = lattice.cellOf[point]!
          const row = Math.floor(slot / lattice.cols)
          const col = slot % lattice.cols
          const sourceRow = row + cells
          const sourceCol = col + cells
          if (sourceRow < 0 || sourceRow >= lattice.rows) continue
          if (sourceCol < 0 || sourceCol >= lattice.cols) continue
          const sourcePoint = lattice.cellIndex[sourceRow * lattice.cols + sourceCol]!
          if (sourcePoint >= 0) shifted[point] = hazard.wet[sourcePoint]!
        }
        return skillOf(shifted, hazard.wet).precision
      }
      const ceiling = shiftedPrecision(1)
      const ours = skills.get(site.event.id)!.precision
      ofCeiling.push([site.event.id, ours / ceiling])
      console.log(
        `| ${site.event.id} | 100.0% | **${percent(ceiling)}** | ` +
          `${percent(shiftedPrecision(2))} | ${percent(ours)} | **${percent(ours / ceiling)}** |`,
      )
    }
    console.log(
      '\nRanked by share of achievable ceiling: ' +
        [...ofCeiling]
          .sort((a, b) => b[1] - a[1])
          .map(([id, share]) => `${id} ${percent(share)}`)
          .join(' > '),
    )

    console.log(
      `\nMean lift ${meanOf([...skills.values()].map((s) => s.lift)).toFixed(2)}x, ` +
        `mean MCC ${meanOf([...skills.values()].map((s) => s.mcc)).toFixed(3)}.`,
    )
  }
}

if (import.meta.main) {
  await main()
}
