/**
 * Does this model put water in the right places in Europe?
 *
 * Every accuracy figure in `docs/specs/flood-model/` is Japanese, and the README has said for
 * several rounds that this is a data limit rather than a choice: Japan publishes its surveys, and
 * nothing equivalent was reachable elsewhere. England does publish them — the Environment Agency's
 * **Recorded Flood Outlines**, 31 696 of them, filtered here to the surveyed extents of two
 * events. So the question can finally be asked outside Japan.
 *
 * It is asked as a **sweep, not a single score**, and that is the whole design of this tool.
 *
 * The Japanese events are driven with storm totals out of official post-event reports. These two
 * have no such figure to hand and are driven with ERA5 instead, which is a 0.25° reanalysis and
 * under-catches orographic rain badly — it offers 29 mm for the day Storm Desmond put a UK-record
 * 341 mm on Honister Pass. A single score at that forcing would measure the rainfall, not the
 * model, and would read as a model failure.
 *
 * Sweeping separates them, exactly as `storm-sweep.ts` does for Nagano:
 *
 *   - If **hit rate climbs while precision holds** as rainfall grows, the model was putting water
 *     in the right places all along and was simply given too small a storm.
 *   - If **precision falls away** as the extent grows, the model is wrong here and no rainfall
 *     recovers it.
 *
 * The row marked `<-` is the one whose modelled area is closest to the surveyed area. That is the
 * fairest single comparison available without a trustworthy storm total: it asks "given the right
 * *amount* of water, does it go to the right *places*", which is the question this model exists to
 * answer and the only one this reference can settle.
 *
 *   bun tools/hindcast/eu.ts [event...]
 */
import { EU_EVENT_IDS, JP_EVENT_IDS, eventById, type HindcastEvent } from './events'
import { fetchObserved, loadObserved, type Observed } from './observed'
import { runModel, warmClimatology } from './model'
import { buildLattice, percent, scoreRun, type Score } from './score'

/**
 * The ladder. It starts at the ERA5 total each event is nominally driven with and climbs past what
 * the real storms are believed to have dropped, so the area-matching forcing is bracketed rather
 * than extrapolated to.
 */
const RAINFALL_MM = [100, 150, 200, 250, 300, 400] as const

interface Row {
  readonly rainfallMm: number
  readonly score: Score
  readonly modelKm2: number
}

/**
 * The metrics that survive a change of site.
 *
 * Precision does not: it depends on how much of the scored window is wet before any model runs,
 * and these windows differ. `prevalence` is that number, reported so the others can be read
 * against it. MCC and informedness both account for it — informedness is hit rate plus specificity
 * minus one, so a model that wins by painting everything wet scores zero rather than well.
 */
const skill = (s: Score) => {
  const { truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn } = s
  const total = tp + fp + fn + tn
  const denominator = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
  return {
    prevalence: total > 0 ? (tp + fn) / total : 0,
    mcc: denominator > 0 ? (tp * tn - fp * fn) / denominator : 0,
    informedness: (tp + fn > 0 ? tp / (tp + fn) : 0) + (tn + fp > 0 ? tn / (tn + fp) : 0) - 1,
  }
}

const runOne = async (site: Observed): Promise<ReadonlyArray<Row>> => {
  const lattice = buildLattice(site)
  const rainfalls = [site.event.rainfallMm, ...RAINFALL_MM].sort((a, b) => a - b)
  const rows: Array<Row> = []

  for (const rainfallMm of rainfalls) {
    process.stdout.write(`  ${site.event.id} @ ${rainfallMm} mm ... `)
    try {
      const run = await runModel(site, { rainfallMm })
      const score = scoreRun(lattice, run)
      rows.push({ rainfallMm, score, modelKm2: run.floodedAreaKm2 })
      console.log(`IoU ${percent(score.iou)}`)
    } catch (err) {
      console.log(`refused: ${(err as Error).message.slice(0, 160)}`)
    }
  }
  return rows
}

const report = (event: HindcastEvent, observed: Observed, rows: ReadonlyArray<Row>): void => {
  console.log(`\n${event.label}`)
  console.log(
    `  surveyed ${observed.areaKm2.toFixed(1)} km² (EA Recorded Flood Outlines, data_src=Survey), ` +
      `scored on a 100 m lattice inside the surveyed footprint`,
  )

  if (rows.length === 0) {
    console.log('  no run completed; nothing to report')
    return
  }

  // The fairest single row: the storm that produces about the right amount of water.
  const matched = rows.reduce((best, row) =>
    Math.abs(row.score.modelAreaKm2 - row.score.observedAreaKm2) <
    Math.abs(best.score.modelAreaKm2 - best.score.observedAreaKm2)
      ? row
      : best,
  )

  console.log(`  prevalence ${percent(skill(rows[0]!.score).prevalence)} of the scored window`)
  console.log('   rain    model    obs   over    POD   prec    IoU    MCC   inform')
  for (const row of rows) {
    const s = row.score
    const k = skill(s)
    const mark = row === matched ? ' <-' : ''
    console.log(
      `  ${String(row.rainfallMm).padStart(5)}  ${s.modelAreaKm2.toFixed(1).padStart(6)} ` +
        `${s.observedAreaKm2.toFixed(1).padStart(6)} ${s.overPredictionRatio.toFixed(1).padStart(5)}× ` +
        `${percent(s.pod).padStart(6)} ${percent(s.precision).padStart(6)} ${percent(s.iou).padStart(6)} ` +
        `${k.mcc.toFixed(3).padStart(6)} ${k.informedness.toFixed(3).padStart(6)}${mark}`,
    )
  }

  const first = rows[0]!
  const last = rows[rows.length - 1]!
  const podGain = last.score.pod - first.score.pod
  const precisionDrop = first.score.precision - last.score.precision
  console.log(
    `  across the sweep: hit rate ${podGain >= 0 ? '+' : ''}${(podGain * 100).toFixed(1)} pts, ` +
      `precision ${precisionDrop >= 0 ? '-' : '+'}${(Math.abs(precisionDrop) * 100).toFixed(1)} pts`,
  )
}

const main = async (): Promise<void> => {
  const ids = process.argv.slice(2)
  const events = (ids.length > 0 ? ids : [...EU_EVENT_IDS]).map(eventById)

  await fetchObserved(events)
  const sites = await Promise.all(events.map(loadObserved))

  // Puts each site's ERA5 series on disk before anything scored runs, so the daily archive cap
  // cannot bite halfway through and leave half the sweep on a different model.
  console.log('warming climatology ...')
  await warmClimatology(sites)

  for (const site of sites) {
    console.log(`\nrunning ${site.event.id} ...`)
    const rows = await runOne(site)
    report(site.event, site, rows)
  }

  /**
   * How wet each window is before any model runs.
   *
   * This is the number that makes precision incomparable between sites, and it costs nothing to
   * report: it depends on the survey and the lattice alone, not on the model, so the Japanese
   * events can be included without running anything.
   */
  console.log('\nprevalence of the scored window — the floor any precision figure is read against')
  for (const id of [...EU_EVENT_IDS, ...JP_EVENT_IDS]) {
    try {
      const event = eventById(id)
      await fetchObserved([event])
      const site = await loadObserved(event)
      const lattice = buildLattice(site)
      let wet = 0
      for (const value of lattice.observed) if (value === 1) wet++
      const region = (EU_EVENT_IDS as ReadonlyArray<string>).includes(id) ? 'EU' : 'JP'
      console.log(
        `  ${region}  ${id.padEnd(11)} ${percent(wet / lattice.observed.length).padStart(6)}` +
          `   (${site.areaKm2.toFixed(1)} km² surveyed)`,
      )
    } catch (err) {
      console.log(`  --  ${id.padEnd(11)}    n/a   (${(err as Error).message.slice(0, 80)})`)
    }
  }

  console.log(
    '\nPrecision is not comparable between sites or with the Japanese figures: it depends on how ' +
      'much of each window is wet to begin with. Read the sweep, not one row.',
  )
}

await main()
