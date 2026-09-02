# Plan — Precision profile, and where the error actually lives

- **Status:** Complete. The profile closed four lines of attack and bounded a fifth (§3-§5); the fix
  it pointed to is implemented, measured, and **shipped as the default** (§7). Round nine
  ([`plan-stage-smoothing.md`](./plan-stage-smoothing.md)) then spent the stage-allocation headroom
  §5 priced; reproduce this round's figures with `stageSmoothingM: 0` (harness config `unsmoothed`).
- **Last updated:** 2026-08-31
- **Inputs:** [`plan-stage-reconciliation.md`](./plan-stage-reconciliation.md) (round seven,
  falsified) · [`design.md`](./design.md) §2, §10, §11 · [`requirements.md`](./requirements.md)
- **Scope:** `tools/hindcast/`, `server/routes/flood-model.ts`, `src/lib/hydrology/fluvial.ts`,
  `src/lib/hydrology/channel.ts`

## 1. Why

Round seven ended with all three of its workstreams falsified on their own terms. Rounds three
through seven all changed **how the river's stage is chosen**, and the mean IoU across them moved
from 16.8% to 16.8%.

So this round does not propose a fix. It asks a different question: **which cells is the model
wrong about, and what do they have in common?** Nothing in the specs had ever decomposed the
error — every figure was a whole-event score.

## 2. The harness, finally in the repository

Round seven's §9 recorded that the harness "still lives outside the repository, and this is the
third time it has been rebuilt". It was gone again. It is now `tools/hindcast/`.

**The rebuild is verified, not merely present.** All four GSI archives download byte-identical to
the recorded sizes (61 003 / 34 860 / 5 330 283 / 49 622 B), the parsed observed areas reproduce
35.8 / 8.9 / 20.1 / 4.8 km², and the single-section curve — the default before §7 — reproduces §1a of round seven exactly:

| Event | IoU | §1a | POD | Precision | poly/grid |
|---|---|---|---|---|---|
| Joso | 16.3% | 16.3% | 45.2% | 20.4% | 1.00× |
| Mabi | 16.1% | 16.1% | 36.1% | 22.5% | 1.00× |
| Nagano | 10.7% | 10.7% | 48.3% | 12.1% | 1.00× |
| Kuma | 24.0% | 24.0% | 63.8% | 27.8% | 1.00× |
| **mean** | **16.8%** | **16.8%** | **48.3%** | **20.7%** | 1.00× |

Joso's KML also turns out to record the survey's own 破堤箇所 and 越水箇所 — the levee breach and
overtopping points. Nothing had used them (§6).

## 3. The profile

Five cuts through the same four runs. **All of §3 to §6 is measured on the single-section rating
curve**, which was the default when the profiling was done and is what §7 then changed; those
figures are not comparable with the ones the model now returns, and the harness keeps that
configuration as `single` so they stay reproducible.

### 3.1 The over-prediction is not a halo

False positives, by distance from the surveyed extent:

| Event | ≤100 m | ≤300 m | ≤1 km | ≤3 km | >3 km | FP km² |
|---|---|---|---|---|---|---|
| Joso | 1.9% | 5.2% | 18.4% | 49.9% | 24.6% | 60.9 |
| Mabi | 8.6% | 10.1% | 20.8% | 46.1% | 14.4% | 11.2 |
| Nagano | 6.2% | 9.8% | 31.3% | 28.9% | 23.8% | 67.8 |
| Kuma | 19.7% | 18.2% | 15.4% | 35.9% | 10.7% | 7.9 |

Between 47% and 75% of the wrongly-flooded ground is **more than a kilometre** from anything that
flooded. This is not an extent that is slightly too generous — it is an extent in the wrong places.
Every hypothesis of the form "the stage is a bit too high" is answering a question the data does
not ask.

The model also **misses half of what did flood** while doing it: POD is 36–64%. It is not a
dilation of the truth.

### 3.2 The deeper the model says, the more often it is wrong

Keeping only cells at or above a depth, on the four-event mean:

| Keep | mean IoU | mean POD | mean precision |
|---|---|---|---|
| ≥ 0.05 m (as shipped) | 16.8% | 48.3% | **20.7%** |
| ≥ 0.50 m | 15.6% | 41.2% | 20.0% |
| ≥ 3.00 m | 8.7% | 15.3% | 16.4% |
| ≥ 5.00 m | 5.9% | 9.0% | 14.8% |

Precision **falls** as the threshold rises. The model's confident water is its worst water, which
is the opposite of what a depth band is supposed to mean to a reader.

### 3.3 Both mechanisms are wet in the same wrong places

Scored inside the surveyed footprint, each field on its own:

| Event | pluvial POD / prec | fluvial POD / prec | reported POD / prec |
|---|---|---|---|
| Joso | 23.6% / 15.7% | 36.0% / 23.0% | 45.2% / 20.4% |
| Mabi | 21.2% / 23.0% | 26.7% / 22.3% | 36.1% / 22.5% |
| Nagano | 32.3% / 13.6% | 36.2% / 11.9% | 48.3% / 12.1% |
| Kuma | 12.6% / 17.5% | 61.5% / 30.3% | 63.8% / 27.8% |

Between 21% and 41% of the false-positive area is wet in **both** fields independently. Deleting
either mechanism outright leaves most of the error standing.

### 3.4 No filter on the reported extent rescues it

Eight rules, all computed from the two component fields without re-running the model:

| Rule | mean IoU | mean POD | mean precision |
|---|---|---|---|
| baseline | **16.8%** | 48.3% | 20.7% |
| river stage only | 16.4% | 40.1% | 21.9% |
| rain ponding only | 10.3% | 22.4% | 17.5% |
| pluvial cells > 3 m dropped | 16.8% | 47.3% | 20.9% |
| whole pluvial ponds reaching 3 m dropped | 16.5% | 44.4% | 20.9% |
| whole pluvial ponds reaching 5 m dropped | 16.6% | 46.2% | 20.6% |
| river cells > 3 m dropped | 14.9% | 39.4% | 20.0% |
| both dropped | 15.0% | 34.0% | 21.9% |

The best of them buys 1.2 points of precision with 8 to 14 points of hit rate, and **not one moves
mean IoU by half a point**. Deep pluvial ponding really is almost always wrong — 2–18% precision in
the high and extreme bands — but there is too little of it to matter.

**Filtering the output is a dead end, and this closes it.**

## 4. What the profile rules out

- Vectorisation and dilation — the harness now rejects any run whose returned polygons disagree
  with its own reported grid area by more than 1%, so every figure in this document is from a run
  at 1.00×.
- A globally over-generous stage — §3.1.
- Either mechanism being the culprit — §3.3.
- Any depth threshold, band rule or pond filter — §3.2, §3.4.

## 5. The ceiling: how good can HAND on this terrain be?

Rather than propose a fifth way to choose the stage, measure what choosing it perfectly is worth.
`uniformStageM` (a diagnostic, §8) stands every reach at one height and skips the rating curve
entirely. Sweeping it and taking the best row per site is the best extent HAND on this DEM can
produce with hindsight:

| Event | best stage | IoU | POD | precision | single-section IoU |
|---|---|---|---|---|---|
| Joso | 7 m | **24.5%** | 83.3% | 25.8% | 16.3% |
| Mabi | 7 m | **27.8%** | 77.0% | 30.3% | 16.1% |
| Nagano | 4 m | **15.4%** | 68.8% | 16.5% | 10.7% |
| Kuma | 10 m | **18.2%** | 67.2% | 20.0% | 24.0% |
| **mean** | | **21.5%** | | **23.2%** | **16.8%** |

The compound curve of §7 closes about a third of that gap — mean IoU 18.2% against the 21.5%
ceiling — and the rest of it is not reachable by any stage rule.

Two things fall out, and they point in opposite directions.

**There is real headroom in stage assignment — 4.7 points of IoU.** A constant stage chosen with
hindsight beats the solved rating curve at three of four sites, at Joso by 8 points. The solved
stage is not uniformly too high or too low; it is **misallocated between reaches** — too low across
the floodplain that matters while a hundred flat reaches peg at the 20 m ladder limit.

**The precision target is out of reach by this method.** Across the entire sweep, at every site and
every stage, precision never exceeds 34.3%; the best mean is 25.0%. Round seven's target of >28%
mean precision cannot be reached by any choice of stage on this DEM. **Precision is bounded by how
well HAND discriminates here, and stage work cannot raise that bound.**

Kuma is the honourable exception in the other direction: its solved curve (24.0%) beats every
constant stage (best 18.2%), so per-reach variation is carrying real information there.

## 6. Two things the profile turned up on the way

**The breach planner has no locational skill.** Joso is the one site where the survey records where
the levee actually failed. The model's three predicted breaches land **19.0, 20.0 and 20.2 km** from
it — at the domain edge, on the largest-drainage cells, while the real breach is 3.3 km from the
query centre. Round seven's §10 argues the residual error is irreducible "without knowing which
levee failed"; this says the model's own breach prediction is not a substitute for knowing.

**`breaches[].cell` was unusable.** It was a raw index into a mosaic the caller never sees, so a
predicted failure could not be put on a map at all. It now carries `latitude`/`longitude`.

## 7. The fix: a compound rating curve

§5 says the stage is misallocated and too low where it matters. There is a standard reason for
exactly that, and it was visible in the code: `fluvialInundation` applied **one Manning n to the
channel and the floodplain alike**, and the default 0.035 is a clean channel. A real floodplain —
vegetated, built up, fenced, ditched — is 0.05 to 0.15. Too smooth a floodplain conveys too much, so
the rating curve is satisfied at too low a stage, on exactly the wide shallow sections where the top
width is kilometres and the error is largest.

`channel.ts` had already reasoned this out and defined `FLOODPLAIN_MANNING_N`. Nothing ever called
it.

### Two formulations, and why the choice is a measurement

- **`composite`** keeps one section and blends the roughnesses over the wetted perimeter
  (Horton 1933; Einstein 1934). Conveyance changes only because the roughness did, so it reduces
  *exactly* to the previous curve when both values agree — asserted by unit test.
- **`divided`** gives the channel and the floodplain their own conveyance and sums them
  (Chow 1959 §6). Splitting raises conveyance by itself, because the channel sub-section has a far
  larger hydraulic radius than the section average, so it **lowers** the solved stage even at
  unchanged roughness. The two effects fight.

Neither is decidable from first principles here, because the DEM does not resolve the channel: a
"channel" cell is one 60–90 m cell of floodplain-level ground, so the deep efficient sub-section
`divided` credits is not one the terrain shows.

### Measured

Both, swept over the floodplain roughness, channel roughness held at 0.035:

| n_floodplain | composite IoU / POD / prec | divided IoU / POD / prec |
|---|---|---|
| 0.035 (= channel, the old curve) | 16.8% / 48.3% / 20.7% | — |
| 0.06 | 17.2% / 51.1% / 20.7% | — |
| 0.08 | 17.5% / 53.2% / 20.8% | — |
| **0.10** | **18.2% / 56.9% / 21.2%** | 18.2% / 54.8% / 21.5% |
| 0.15 | 18.3% / 58.7% / 21.1% | 18.3% / 56.4% / 21.4% |
| 0.20 | 18.5% / 61.4% / 21.0% | 18.7% / 58.6% / 21.7% |
| 0.25 | 18.8% / 63.5% / 21.2% | 18.9% / 60.1% / 21.8% |
| 0.30 | 19.3% / 66.4% / 21.4% | 19.6% / 63.1% / 22.2% |

poly/grid was 1.00× in all 44 runs.

**The two methods score the same in IoU at the same n**; `divided` simply trades a few points of hit
rate for a few tenths of precision. What separates them is what their n *means*. `composite`
reduces to the old curve at equal roughness, so its n is the literature's n. `divided`'s is not:
splitting has already added conveyance, so it needs roughly twice the roughness to stand the river
at the same height, and a `divided` n of 0.20 is not the 0.20 in Chow's table.

### The parameter cannot be calibrated here, and that decides the value

**The score rises monotonically with roughness across the whole physical range and past it.** There
is no interior optimum, in either method, up to the 0.3 validation cap. These four events cannot
identify the value, and a sweep with no turning point is a knob, not a calibration.

That is not a reason to reject the change — the defect it fixes is real and the direction is not in
doubt — but it does mean **the value has to come from the literature rather than from the score**.
Chow (1959) table 5-6 puts pasture, brush and cultivated land at 0.05–0.12. **0.10 is taken from
that range**, and the fact that it also happens to be where the steep part of the curve ends is a
coincidence that is not being leaned on.

Two things stop the monotone rise from being a reason for suspicion:

- **Precision does not fall as extent grows** — 20.7% → 21.2% at 0.10, still 21.4% at 0.30 — while
  hit rate climbs from 48% to 66%. The added ground is about as accurate as the ground already
  there, so this is not dilution. Compare §5, where a rising uniform stage bought extent at falling
  marginal precision.
- **poly/grid stays 1.00×**, so none of it is vectorisation dilating the extent.

### Outcome against §7's acceptance test

| Metric | Before | Target | Falsifies | Measured at 0.10 |
|---|---|---|---|---|
| mean IoU | 16.8% | > 18% | < 17.8% | **18.2%** ✅ |
| mean POD | 48.3% | > 55% | < 50% | **56.9%** ✅ |
| mean precision | 20.7% | ≥ 20.7% | < 20% | **21.2%** ✅ |
| poly/grid | 1.00× | 1.00× | any drift | 1.00× ✅ |

Every site improves, which none of the previous five rounds managed:

| Event | IoU | POD | Precision |
|---|---|---|---|
| Joso | 16.3% → **17.1%** | 45.2% → 50.5% | 20.4% → 20.5% |
| Mabi | 16.1% → **18.1%** | 36.1% → 44.1% | 22.5% → 23.6% |
| Nagano | 10.7% → **11.0%** | 48.3% → 54.3% | 12.1% → 12.1% |
| Kuma | 24.0% → **26.6%** | 63.8% → 78.5% | 27.8% → 28.7% |

**Shipped as the default**, at `floodplainManningN` 0.10 with `compoundMethod: 'composite'` — the
first change since round two to pass its acceptance test. `divided` is retained as a request option
and measured above, on the same reasoning that keeps `stageDischarge: 'excess'` around: two
defensible readings, and the one not in use should stay comparable rather than be argued about.

**Every accuracy figure recorded before this round was measured with the single-section curve.** It
is reproduced exactly by setting `floodplainManningN` equal to `manningN`, which is the harness's
`single` configuration, and the harness checks both baselines on every run.

### What it does not fix

The extent grows by about 11% (Joso 300 → 334 km²), so over-prediction gets worse in absolute terms
even as precision improves slightly: the model is still 2.5× over the surveyed extent inside the
scored window. This buys hit rate, which the model badly needed at 48%, and it does not touch the
ceiling of §5 — precision is still bounded around 25% by how weakly HAND discriminates on this
terrain, and that bound is where the next round has to look.

## 8. Diagnostics added to make this measurable

All three default off and are recorded here because a measurement nobody can repeat is not one.

- **`componentZones`** — vectorises the pluvial and fluvial fields separately. `attribution`
  already reported each part's *area*; without its *shape* there was no way to ask which mechanism
  owned a wrong cell. Two extra vectorisation passes, so it is opt-in.
- **`uniformStageM`** — stands every reach at one height and skips the rating curve. Not a
  modelling option: it exists to bound the method (§5).
- **`breaches[].latitude/longitude`** — see §6.

One more hazard surfaced while measuring, and it is fixed rather than merely
reported. Overpass returns 504 and 429 on a 20 km box under load, and the route
degrades to "no known defences" with nothing but `defences.status` to say so —
18.5 km² of extent at Joso, enough to invalidate a comparison. It cost this
round two measurement runs. Mapped embankments are now kept on disk under
`LEVEE_CACHE_DIR`, exactly as the rainfall climatology is, so a site is asked for
once rather than once per server restart; an outage is never stored, because
remembering one would turn a gateway timeout into a permanent undefended
floodplain. `defences.retrievedFrom` reports `overpass`, `stored` or `none`.

## 9. What this does not answer

- **Why HAND discriminates so poorly here** is still open. The candidates are DEM vertical accuracy
  against a floodplain with metres of total relief, D8 drainage directions on flat filled ground,
  and inundation being controlled by embankments rather than elevation. §5 bounds the cost of it
  (precision ≤ 34%) without diagnosing it. A finer DEM is already
  [`design.md`](./design.md) §11's second follow-up; the ceiling sweep re-run on a 5 m GSI DEM is
  the test, and it is now cheap to run.
- **Nagano stays poor** for the reason round seven gave: its observed extent spans the whole
  Chikuma corridor and the scope mismatch is in the reference.
- **Timing** is untouched, and `componentZones` makes a request slower still.

## 10. Reproducing

```bash
GEO_DATA_MODE=live PORT=9090 GEO_CACHE_TTL_FLOOD_MS=1 bun run server/index.ts
bun tools/hindcast/run.ts fetch
bun tools/hindcast/run.ts score baseline n060 n100 n150   # §2, §7
bun tools/hindcast/profile.ts                             # §3.1-3.3
bun tools/hindcast/counterfactual.ts                      # §3.4
bun tools/hindcast/ceiling.ts                             # §5
bun tools/hindcast/breach-check.ts                        # §6
bun tools/hindcast/roughness-attribution.ts               # §7
```

The ERA5 climatology for all four sites is already on disk; nothing above touches the archive. See
[`tools/hindcast/README.md`](../../../tools/hindcast/README.md) for what invalidates a run.
