/**
 * Which reference should precision be measured against?
 *
 * Every accuracy figure this repository has published scores the model against
 * one event's surveyed extent. The model does not predict one event's extent: it
 * maps the ground a design storm can reach. Scoring an envelope against a single
 * realisation charges it for every correct cell that particular flood did not
 * happen to occupy, and no amount of modelling work can win those cells back.
 *
 * The claim needs a control, not an argument, so this scores three things on one
 * lattice:
 *
 *   1. the model against the surveyed event extent   (what we have always done)
 *   2. the model against the official hazard envelope (like against like)
 *   3. **the official hazard envelope against the surveyed event extent**
 *
 * Row 3 is the one that decides it. Japan's 洪水浸水想定区域 is a national,
 * official, professionally produced screening product built by the authority
 * that manages each river. If it also scores poorly against a single event's
 * survey, then that metric is not measuring model quality and an 80% target
 * defined on it is unreachable by construction — by any model, including the
 * official one.
 *
 *   bun tools/hindcast/reference.ts
 */
import { EVENTS } from './events'
import { loadObserved } from './observed'
import { runModel, warmClimatology } from './model'
import { buildLattice, scoreRun, percent, meanOf, type Lattice } from './score'
import { CONFIGS } from './run'
import { loadHazardMask, HAZARD_BANDS, HAZARD_ZOOM, type HazardMask } from './hazard'

const CELL_AREA_KM2 = 0.01

interface Confusion {
  readonly tp: number
  readonly fp: number
  readonly fn: number
  readonly iou: number
  readonly pod: number
  readonly precision: number
}

/** Scores one binary mask against another over the same lattice points. */
const confuse = (predicted: Uint8Array, truth: Uint8Array): Confusion => {
  let tp = 0
  let fp = 0
  let fn = 0
  for (let i = 0; i < predicted.length; i++) {
    const wet = predicted[i] === 1
    const real = truth[i] === 1
    if (wet && real) tp++
    else if (wet) fp++
    else if (real) fn++
  }
  return {
    tp,
    fp,
    fn,
    iou: tp / (tp + fp + fn || 1),
    pod: tp / (tp + fn || 1),
    precision: tp / (tp + fp || 1),
  }
}

const main = async (): Promise<void> => {
  const sites = await Promise.all(EVENTS.map(loadObserved))
  await warmClimatology(sites)

  const lattices = new Map<string, Lattice>(
    sites.map((site) => [site.event.id, buildLattice(site)]),
  )

  console.log('# Which reference? Model, official hazard map, and one event\n')
  console.log(
    `Official envelope: MLIT 洪水浸水想定区域 (L2, maximum assumed scale), read from GSI's\n` +
      `disaster portal at zoom ${HAZARD_ZOOM} (~15 m/px) at the same 100 m lattice points the\n` +
      'model is scored on. Identical points, identical window — only the truth changes.\n',
  )

  const hazards = new Map<string, HazardMask>()
  for (const site of sites) {
    const lattice = lattices.get(site.event.id)!
    hazards.set(site.event.id, await loadHazardMask(lattice.points))
  }

  console.log('## Coverage of the official envelope over each scored window\n')
  console.log('| Event | lattice pts | in envelope | of window | tiles read | not designated |')
  console.log('|---|---|---|---|---|---|')
  for (const site of sites) {
    const cov = hazards.get(site.event.id)!.coverage
    console.log(
      `| ${site.event.id} | ${cov.pointsTotal} | ${cov.pointsInEnvelope} | ` +
        `${percent(cov.pointsInEnvelope / cov.pointsTotal)} | ${cov.tilesRead} | ` +
        `${cov.tilesNotDesignated} |`,
    )
  }

  // ---- The control, which depends on no configuration --------------------
  const envelopeVsEvent = sites.map((site) =>
    confuse(hazards.get(site.event.id)!.wet, lattices.get(site.event.id)!.observed),
  )

  console.log('\n## The CONTROL: the official hazard map scored against the same event survey\n')
  console.log(
    'The official envelope as if it were a prediction of the one event. It depends on no\n' +
      'setting of ours. If this is low, the metric is the problem — not the model.\n',
  )
  console.log('| Event | IoU | POD | Precision |')
  console.log('|---|---|---|---|')
  sites.forEach((site, i) => {
    const c = envelopeVsEvent[i]!
    console.log(`| ${site.event.id} | ${percent(c.iou)} | ${percent(c.pod)} | ${percent(c.precision)} |`)
  })
  console.log(
    `| **mean** | **${percent(meanOf(envelopeVsEvent.map((c) => c.iou)))}** | ` +
      `**${percent(meanOf(envelopeVsEvent.map((c) => c.pod)))}** | ` +
      `**${percent(meanOf(envelopeVsEvent.map((c) => c.precision)))}** |`,
  )

  // ---- Each configuration, against each reference -------------------------
  const names = process.argv.slice(2).length ? process.argv.slice(2) : ['baseline']

  console.log('\n## Precision under each reference, by configuration\n')
  console.log(
    '`vs event` is the metric every published figure uses. `vs envelope` scores the same\n' +
      'model extent, on the same lattice points, against the official hazard map instead.\n',
  )
  console.log(
    '| Config | Event | IoU vs event | Prec vs event | IoU vs envelope | POD vs envelope | Prec vs envelope | FP-in-envelope |',
  )
  console.log('|---|---|---|---|---|---|---|---|')

  for (const name of names) {
    const config = CONFIGS[name]
    if (!config) throw new Error(`unknown config: ${name} (have ${Object.keys(CONFIGS).join(', ')})`)

    const vsEvents: Array<Confusion> = []
    const vsEnvelopes: Array<Confusion> = []
    const shares: Array<number> = []

    for (const site of sites) {
      const lattice = lattices.get(site.event.id)!
      const hazard = hazards.get(site.event.id)!
      const run = await runModel(site, config)

      // The model's own wet mask: `classAt` carries the hazard class, '' where dry.
      const scored = scoreRun(lattice, run)
      const modelWet = Uint8Array.from(scored.classAt, (cls) => (cls === '' ? 0 : 1))

      const vsEvent = confuse(modelWet, lattice.observed)
      const vsEnvelope = confuse(modelWet, hazard.wet)

      // Of the cells the event survey calls wrong, how many are officially flood-prone?
      let fpInEnvelope = 0
      let fpTotal = 0
      for (let i = 0; i < modelWet.length; i++) {
        if (modelWet[i] === 1 && lattice.observed[i] !== 1) {
          fpTotal++
          if (hazard.wet[i] === 1) fpInEnvelope++
        }
      }
      const share = fpInEnvelope / (fpTotal || 1)

      vsEvents.push(vsEvent)
      vsEnvelopes.push(vsEnvelope)
      shares.push(share)
      console.log(
        `| ${name} | ${site.event.id} | ${percent(vsEvent.iou)} | ${percent(vsEvent.precision)} | ` +
          `${percent(vsEnvelope.iou)} | ${percent(vsEnvelope.pod)} | ${percent(vsEnvelope.precision)} | ` +
          `${percent(share)} |`,
      )
    }

    console.log(
      `| **${name}** | **mean** | **${percent(meanOf(vsEvents.map((c) => c.iou)))}** | ` +
        `**${percent(meanOf(vsEvents.map((c) => c.precision)))}** | ` +
        `**${percent(meanOf(vsEnvelopes.map((c) => c.iou)))}** | ` +
        `**${percent(meanOf(vsEnvelopes.map((c) => c.pod)))}** | ` +
        `**${percent(meanOf(vsEnvelopes.map((c) => c.precision)))}** | ` +
        `**${percent(meanOf(shares))}** |`,
    )
  }

  // ---- The cheapest remaining lever, now measured against the right truth ----
  //
  // Under the event reference a depth floor bought precision only by throwing
  // away hit rate, because the water it discarded had flooded somewhere the
  // survey did not cover. Against an envelope the trade is a different one and
  // has to be re-measured rather than assumed to carry over.
  const CLASS_ORDER = ['low', 'moderate', 'high', 'extreme'] as const
  const CLASS_FLOOR_M: Record<string, number> = { low: 0.05, moderate: 0.5, high: 3, extreme: 5 }

  console.log('\n## Reported-depth floor, scored against the official envelope\n')
  console.log('| Config | Keep | mean IoU | mean POD | mean precision |')
  console.log('|---|---|---|---|---|')
  for (const name of names) {
    const config = CONFIGS[name]!
    const classAtBySite = new Map<string, ReadonlyArray<string>>()
    for (const site of sites) {
      const run = await runModel(site, config)
      classAtBySite.set(site.event.id, scoreRun(lattices.get(site.event.id)!, run).classAt)
    }
    CLASS_ORDER.forEach((floor, floorIndex) => {
      const kept = new Set<string>(CLASS_ORDER.slice(floorIndex))
      const ious: Array<number> = []
      const pods: Array<number> = []
      const precisions: Array<number> = []
      for (const site of sites) {
        const classAt = classAtBySite.get(site.event.id)!
        const truth = hazards.get(site.event.id)!.wet
        const mask = Uint8Array.from(classAt, (cls) => (cls !== '' && kept.has(cls) ? 1 : 0))
        const c = confuse(mask, truth)
        ious.push(c.iou)
        pods.push(c.pod)
        precisions.push(c.precision)
      }
      console.log(
        `| ${name} | >= ${CLASS_FLOOR_M[floor]!.toFixed(2)} m (${floor}+) | ` +
          `${percent(meanOf(ious))} | ${percent(meanOf(pods))} | **${percent(meanOf(precisions))}** |`,
      )
    })
  }

  console.log('\n## Envelope depth bands present in the scored windows\n')
  console.log('| Band | ' + sites.map((s) => s.event.id).join(' | ') + ' |')
  console.log('|---|' + sites.map(() => '---|').join(''))
  HAZARD_BANDS.forEach((band, i) => {
    const cells = sites.map((site) => {
      const hazard = hazards.get(site.event.id)!
      let n = 0
      for (const value of hazard.bandAt) if (value === i + 1) n++
      return `${(n * CELL_AREA_KM2).toFixed(1)} km²`
    })
    console.log(`| ${band.label} | ${cells.join(' | ')} |`)
  })
}

if (import.meta.main) {
  await main()
}
