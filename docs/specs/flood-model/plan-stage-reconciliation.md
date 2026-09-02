# Plan — Stage reconciliation and areal reduction

- **Status:** Complete. All three workstreams implemented behind flags and measured — alone,
  combined, and against a re-swept defence multiple. **None of them ships as a default**: the plan
  is falsified on its own terms (§8).
- **Last updated:** 2026-08-30
- **Inputs:** [`requirements.md`](./requirements.md) · [`design.md`](./design.md) §8 (channel
  geometry), §9 (performance) · [`tasks.md`](./tasks.md) follow-ups
- **Scope:** `src/lib/hydrology/fluvial.ts`, `src/lib/hydrology/catchment.ts`,
  `server/routes/flood-model.ts`

## 1. Why

Five rounds of work took the model from "every reach 12 640× over capacity" to physically
sensible discharges, added real embankment data, and made the diagnostics trustworthy. None of it
moved the score. Hindcast against four Japanese flood disasters with mapped extents:

| Event | IoU | POD | Precision |
|---|---|---|---|
| 2015 Kinugawa, Joso | 16.3% | 45.2% | 20.4% |
| 2018 Oda R., Mabi | 16.1% | 36.1% | 22.5% |
| 2019 Chikuma, Nagano | 10.7% | 48.3% | 12.1% |
| 2020 Kuma R., Hitoyoshi | 24.0% | 63.8% | 27.8% |
| **mean** | **16.8%** | **48.4%** | **20.7%** |

**Four fifths of what the model calls flooded did not flood**, and area is over-predicted 3–12×.
The extent is set almost entirely by the stage the HAND rating curve returns, and that stage is too
generous. Two things are known to be wrong with it, and one input is biased in the unsafe
direction.

This plan addresses those three. It is written with a stop rule, because the last two changes that
looked obviously right — the per-cell volume check and the defence gate — both shipped and did
nothing measurable.

## 1a. Locked baseline (P1)

Measured 2026-08-30 against the running server, four events at 20 km radius, driven by the event
rainfall in the table below and scored on a 100 m lattice over the observed footprint padded by
2 km and clipped to the query circle. Every later measurement in this document is against these
numbers, at these settings.

| Event | Storm | Observed | Model | ratio | IoU | POD | Precision | poly/grid |
|---|---|---|---|---|---|---|---|---|
| 2015 Kinugawa, Joso | 490 mm / 48 h | 35.8 km² | 300.2 km² | 8.4× | 16.3% | 45.2% | 20.4% | 1.00× |
| 2018 Oda R., Mabi | 342 mm / 72 h | 8.9 km² | 107.8 km² | 12.1× | 16.1% | 36.1% | 22.5% | 1.00× |
| 2019 Chikuma, Nagano | 196.8 mm / 48 h | 20.1 km² | 80.9 km² | 4.0× | 10.7% | 48.3% | 12.1% | 1.00× |
| 2020 Kuma R., Hitoyoshi | 322 mm / 12 h | 4.8 km² | 51.3 km² | 10.7× | 24.0% | 63.8% | 27.8% | 1.00× |
| **mean** | | | | | **16.8%** | **48.3%** | **20.7%** | **1.00×** |

Diagnostics at baseline: `reachesDefended` 0 everywhere, `reachesVolumeLimited` **0** everywhere,
`reachesStagePegged` 107 / 72 / 95 / 500, `maxRiverStageM` pegged at the 20 m ladder limit at all
four sites.

**One measurement hazard found while locking this down.** The ERA5 climatology is a best-effort
input: when the archive call fails the route silently falls back to area-keyed hydraulic geometry,
which puts trunk bankfull an order of magnitude out (29–50 m³/s instead of 244–1 182). Nothing in
the response made that obvious at a glance, and two runs that differ only in whether the fallback
fired are not comparable. The harness now warms the climatology per site and refuses to score a run
that took the fallback; `climatology.status` should be checked before any figure here is trusted.

## 2. Workstream A — Make the volume check bind

### The defect

`fluvialInundation` already accepts `overbankVolumeM3` and holds each reach's stage to what the
water could fill. It has never once fired: `reachesVolumeLimited` reads **0** at every site, every
storm.

The comparison is at the wrong scale. It tests one channel cell's strip storage against the
overbank volume passing that cell — but the strip is one cell of river length, while the overbank
volume is the whole upstream river's. The bound is loose by the ratio of river length to cell
length, three to four orders of magnitude, so it can never bind. It is currently a safeguard that
reads as if it exists.

### The fix

Make the constraint cumulative, which is the scale the physics is actually at: **the floodplain
storage upstream of a point cannot exceed the overbank volume delivered past that point.**

```
S(c)      = strip storage implied by the stage assigned to channel cell c
cumS(c)   = flowAccumulate(receivers, popOrder, S)      // storage at and above c
O(c)      = max(0, routedVolume(c) − defendedVolume(c)) // what actually went overbank
f(c)      = min(1, O(c) / cumS(c))                      // how much of it is supportable
limit(u)  = min(f(u), limit(receiver(u)))               // one forward pass in pop order
```

`limit(u)` propagates the tightest downstream constraint back upstream, which is correct: if the
budget fails at `c`, everything draining to `c` collectively overspent. Reducing a reach's stage
then means reading back down its own rating curve — the ladder already computes volume at every
trial stage, so inverting is a lookup, not new arithmetic.

One pass is conservative (lowering stages upstream relaxes constraints downstream, so a second pass
could recover a little extent). Start with one; only iterate if §5's acceptance test says the
single pass is over-correcting.

## 3. Workstream B — Reconcile against the defended capacity

### The defect

The defence gate is binary: at or below `channelDefenceMultiple × bankfull` a reach stays
completely dry, above it the reach floods to the stage implied by its **total** discharge. That
discontinuity is why calibration found no useful setting — re-run after the capacity fix, it peaks
at ×2 and then trades away far more hit rate than it buys in precision:

| Defence | mean IoU | mean POD | mean precision |
|---|---|---|---|
| ×1 (default) | 16.8% | 48.3% | 20.7% |
| ×2 | 16.9% | 48.3% | 21.0% |
| ×5 | 15.7% | 41.3% | 21.0% |
| ×12 | 11.8% | 27.4% | 18.7% |

### The fix

A confined channel carries its defended discharge; only the **excess** spreads onto the floodplain.
So the rating curve should be solved for `max(0, Q − Q_defended)` rather than for `Q`, which:

- removes the cliff — the extent grows continuously from the moment defences are exceeded;
- makes `channelDefenceMultiple` a real control rather than an on/off switch;
- lowers every stage, since the floodplain is asked to carry less water.

There is a competing reading worth stating: once a levee is overtopped the whole flow is at that
water surface, so the total discharge sets the stage. Both are defensible. The excess formulation
is the one to test first because it is continuous and because the binary form is already known not
to work. If it under-predicts, the honest fallback is a blend, not a fudge factor.

This only became meaningful once bankfull capacity was real. Ratios are now 4–35× (they were
356–12 640×), so `Q − Q_defended` is a genuinely different number from `Q`.

## 4. Workstream C — Areal reduction on the point rainfall

### The defect

`meanAnnualFloodM3PerS` runs the **point** 2-year rainfall over the whole catchment. A storm does
not fall evenly across 1 000 km²; the areal average is lower than the point value. So Q₂ is
overstated → bankfull capacity is overstated → overtopping is understated → flooding is
understated. That is the unsafe direction for a life-safety tool, and it is the one bias in the
chain currently pointing the wrong way.

### The fix

Apply a standard areal reduction factor before the runoff step. Leclerc & Schaake (1972), as used
in US NWS TP-29, takes exactly the two things already available — storm duration and catchment
area:

```
ARF = 1 − exp(−1.1·D^0.25) + exp(−1.1·D^0.25 − 0.01·A)     D in hours, A in square miles
```

Worked values for a 24 h storm, to be used as acceptance checks:

| Catchment | ARF | Effect |
|---|---|---|
| 10 km² | 0.997 | none, correctly — a point storm covers a small basin |
| 1 000 km² | 0.914 | ~9% less rainfall, ~13% less capacity |
| 5 000 km² | 0.912 | ~9% less rainfall |

The 5 000 km² row as first written (0.89) is not reachable from the formula above: as area grows
the factor flattens at `1 − exp(−1.1·D^0.25)`, which is 0.912 at 24 h. The corrected value is what
the unit tests assert.

It is US-derived and applied globally, exactly like the hydraulic geometry it sits beside, and must
be documented as such in `limitations`. Expose it as `arealReduction` (default on) so its effect
can be isolated.

## 5. Requirements

- **R5.1** The volume constraint is evaluated cumulatively along the drainage network, and
  `reachesVolumeLimited` is non-zero on at least one hindcast event — a safeguard that never fires
  is not a safeguard.
  **Met, on a technicality worth stating plainly.** The constraint is cumulative and does read
  non-zero — 287 reaches at Nagano, 230 at Joso — but only once `channelDefenceMultiple` is raised
  to ×2-×5, which the same measurement shows is a worse place to be. At the shipped ×1 it is zero
  at all four sites, because the storm delivers 2.0-7.8× more water than the mapped surface needs
  (§8). So it is a live safeguard over a part of the parameter space nobody should use, which is
  not what R5.1 was asking for. It is reported as a diagnostic (`network.volumeBudget`) rather than
  left in the code looking like protection it does not give.
- **R5.2** Fluvial stage is solved for discharge in excess of the defended capacity, so extent
  responds continuously to `channelDefenceMultiple` with no cliff.
  **Met, behind `stageDischarge: 'excess'`.** Continuity is asserted by unit test; the flag is not
  the default because §8 measured it slightly worse.
- **R5.3** Point rainfall is areally reduced before Q₂; the factor and the reduced rainfall are
  reported alongside the raw value.
  **Met, behind `arealReduction`.** `climatology.arealReductionFactor` and
  `climatology.arealReducedTwoYearRainfallMm` sit beside `twoYearDailyRainfallMm`.
- **R5.4** Volume conservation and the existing 945 tests continue to pass unchanged.
  **Met.** 945 → 960, all passing: the areal reduction factor, the cumulative constraint, the
  excess ramp, the reported-but-not-applied budget, and the climatology's on-disk reuse.
- **R5.5** `inundation.zones` continues to agree with `inundation.floodedAreaKm2` to within 1%
  (currently 1.00×) — no repeat of the vectorisation dilation.
  **Met.** 1.00× in all 60 scored runs behind §8; the ratio is checked by the harness on every
  request rather than spot-checked.
- **R5.6** Every change is measured on the same four events, at the same settings, before and
  after. No change ships on plausibility.
  **Met, and it is why none of them ships.** Eight configurations and a seven-point defence sweep,
  all on one reference dataset and one climatology. It also turned up two hazards of its own: the
  measurement was not reproducible until the harness was made to reject a run whose climatology had
  silently fallen back (§1a), and the climatology itself had to be made durable before a campaign
  could be run at all without exhausting the archive's daily allowance.

## 6. Tasks

| Id | Task | Reqs | Status |
|---|---|---|---|
| P1 | Record a locked baseline: the four events at default settings, committed as numbers in this file | R5.6 | ✅ §1a |
| P2 | `fluvialInundation`: replace the per-cell volume test with the cumulative form; return the storage field | R5.1 | ✅ |
| P3 | Route: accumulate strip storage, compute `f`/`limit`, feed the limit back into the stage | R5.1 | ✅ — done inside `fluvial.ts`, which already has the strip geometry; the route passes `receivers`/`popOrder` |
| P4 | Solve the rating curve for `Q − Q_defended`; keep the total-Q path behind a flag for comparison | R5.2 | ✅ — and total-Q is still the default, see §8 |
| P5 | `arealReductionFactor` in `catchment.ts`, applied in `meanAnnualFloodM3PerS`; unit tests on the worked values in §4 | R5.3 | ✅ — one worked value in §4 was wrong and is corrected |
| P6 | Re-run the hindcast for each workstream **separately**, then combined | R5.6 | ✅ all eight configs, §8 |
| P7 | Re-calibrate `channelDefenceMultiple` against the continuous formulation | R5.2 | ✅ ×1 stands, §8 |
| P8 | Update `limitations`, `design.md`, `geo-sources.md`; delete any claim these changes falsify | R5.4 | ✅ |

Order matters: P5 is independent and can land first; P2–P3 and P4 both change the stage and must be
measured apart before being measured together.

## 7. Acceptance, and when to stop

Expected direction, on the four-event mean:

| Metric | Now | Target | Would falsify the plan |
|---|---|---|---|
| Precision | 20.7% | **> 28%** | < 22% after all three |
| POD | 48.4% | > 40% (some loss is expected and acceptable) | < 35% |
| IoU | 16.8% | **> 20%** | ≤ 17% |
| Polygon/grid agreement | 1.00× | 1.00× | any drift |

**Outcome, measured (§8).** Against the targets above, with all three applied (`ABC`):

| Metric | Now | Target | Falsifies | Measured |
|---|---|---|---|---|
| Precision | 20.7% | > 28% | < 22% | **20.6%** — falsified |
| POD | 48.4% | > 40% | < 35% | 47.1% — inside tolerance |
| IoU | 16.8% | > 20% | ≤ 17% | **16.6%** — falsified |
| Polygon/grid | 1.00× | 1.00× | any drift | 1.00× in all 60 runs |

Precision and IoU both land in the "would falsify the plan" column, and the polygon/grid ratio
confirms nothing was gained or lost to dilation. The re-swept defence multiple (§8) found no
setting better than the existing ×1. **The plan is falsified on its own terms, which is the
result.**

**Stop rule.** If a workstream moves mean IoU by less than 1 point, it does not ship on the
argument that it is more correct — it gets reverted or demoted to a reported diagnostic, and the
measurement is written up. That rule exists because it has already been needed twice: the per-cell
volume check and the ×1–×12 defence sweep both looked right and both did nothing, and the
vectorisation coarsening actively made the output wrong while appearing to improve POD by 12 points.

Watch for the same trap here: **any apparent gain must be checked against the polygon/grid
agreement ratio before it is believed.** Dilating the extent raises POD for free.

## 8. Results

Implemented as three independent request flags, `volumeConstraint`, `stageDischarge` and
`arealReduction`, so each could be measured on its own and in combination against §1a at identical
settings (P6). Every figure below is from a run whose ERA5 climatology was real at all four sites —
a run that took the fallback is not comparable, and the harness refuses to score one.

The whole matrix was re-measured after the harness and the GSI reference data had to be rebuilt
from scratch. Two checks say the rebuild is faithful: the four archives download byte-identical in
size, and **`baseline` reproduces §1a exactly at every site** — 300.2 / 107.8 / 80.9 / 51.3 km²,
16.3 / 16.1 / 10.7 / 24.0% IoU. The climatology also came back identical (Joso 74.8 mm over 66
years, the value round five recorded). A, B and C reproduced their first measurement exactly too.

| Config | mean IoU | mean POD | mean precision | poly/grid | vs baseline |
|---|---|---|---|---|---|
| baseline | 16.8% | 48.3% | 20.7% | 1.00× | — |
| A — cumulative volume constraint | 16.8% | 48.3% | 20.7% | 1.00× | **nothing, to three figures** |
| B — stage from the excess discharge | 16.5% | 46.9% | 20.5% | 1.00× | **−0.3 IoU, −1.4 POD** |
| C — areal reduction on Q₂ | 16.8% | 48.3% | 20.7% | 1.00× | **nothing** |
| AB | 16.5% | 46.9% | 20.5% | 1.00× | identical to B |
| AC | 16.8% | 48.3% | 20.7% | 1.00× | identical to C |
| BC | 16.6% | 47.1% | 20.6% | 1.00× | **−0.2 IoU** |
| ABC | 16.6% | 47.1% | 20.6% | 1.00× | identical to BC |

The combinations add nothing the parts did not. A is exactly inert, so AB is B and AC is C to every
digit. The one real interaction is the predicted one: C alone cannot reach the extent, but with B
solving for the excess it recovers 0.1 of the 0.3 points B costs, because a lower bankfull leaves
more discharge to spread. It is a coupling, and it is a tenth of a point.

Per event, model extent in km²:

| Event | baseline | A | B | C |
|---|---|---|---|---|
| Joso | 300.2 | 300.2 | 296.9 | 300.2 |
| Mabi | 107.8 | 107.8 | 104.6 | 107.9 |
| Nagano | 80.9 | 80.9 | 78.9 | 80.9 |
| Kuma | 51.3 | 51.3 | 50.4 | 51.3 |

**All three fail the §7 stop rule**, which asks for a full point of mean IoU. B is negative. The
defaults therefore stay exactly where round six left them, and each change ships as an opt-in flag
with its default recorded in `flood-model.ts`. The stop rule's other option — demote to a reported
diagnostic — is taken for A: the budget is now evaluated on every request and reported as
`network.volumeBudget`, whether or not it is allowed to move the stage.

### P7 — the defence multiple, re-swept against the continuous formulation

This was the one result that could still have changed the picture. The ×1–×12 sweep in §3 was run
against the binary gate, where raising the multiple flips whole reaches from fully flooded to dry —
a discontinuity a sweep cannot calibrate. Re-swept under `stageDischarge: 'excess'`, with the
volume constraint and the areal reduction both on, so that the response is continuous:

| Defence | mean IoU | mean POD | mean precision | poly/grid |
|---|---|---|---|---|
| ×1 | **16.6%** | 47.1% | 20.6% | 1.00× |
| ×1.5 | 16.4% | 46.4% | 20.4% | 1.00× |
| ×2 | 16.3% | 45.6% | 20.6% | 1.00× |
| ×3 | 16.0% | 42.1% | 20.8% | 1.00× |
| ×5 | 15.5% | 39.1% | 21.0% | 1.00× |
| ×8 | 15.0% | 33.9% | 21.9% | 1.00× |
| ×12 | 11.9% | 26.6% | 19.1% | 1.00× |

**IoU falls monotonically from ×1.** Precision does climb — 20.6% to 21.9% at ×8 — but it buys 1.3
points of precision with 13 points of hit rate, and at ×12 it gives up even the precision. Making
the response continuous did not create a useful setting where the binary form had none; it simply
made the same conclusion legible. **×1 stands, and it is now a measured floor rather than the
conservative end of a sweep that could not discriminate.**

The gate does discriminate now, which is worth recording separately from the score:
`reachesDefended` runs 0 at ×1 and 5 234 / 6 000 / 6 821 / 7 969 at the four sites by ×8-12, where
before the capacity fix it was 0 everywhere at every multiple.

### A — why a cumulative volume budget still does not bind

The scale fix was real: the per-cell test compared one strip against the whole upstream river's
overbank volume and was loose by three or four orders of magnitude, and the cumulative form removes
that. It still never fires, and the budget now says why. At Joso, on the real climatology:

| | Joso |
|---|---|
| Floodplain storage the mapped stages imply | 416 Mm³ |
| Overbank volume delivered past the main stem | 1 006 Mm³ |
| Tightest supportable share anywhere | 1.000 |

**The river delivers more water than the map asks for at every site**, so there is nothing for the
constraint to take away. Measured across all four, on the real climatology:

| Site | Mapped storage | Delivered past the main stem | Surplus |
|---|---|---|---|
| Joso | 389 Mm³ | 1 014 Mm³ | 2.6× |
| Mabi | 87 Mm³ | 682 Mm³ | 7.8× |
| Nagano | 139 Mm³ | 894 Mm³ | 6.4× |
| Kuma | 290 Mm³ | 579 Mm³ | 2.0× |

That is not a bug in the arithmetic, it is a category error in the test: `O` is a *throughput* over
the whole storm while `S` is a *storage*, and comparing them assumes every cubic metre that went
overbank is still standing there at the end. It is not — it drains downstream. A volume test can
only bind if the overbank volume is credited over a floodplain **residence time** of hours rather
than over the event duration; at Joso a 6 h window would put the supportable share near 0.3 and
would bite hard. That is a different change, with a new parameter nothing in the model currently
determines, and it is not in this plan.

**It is not dead code, though, and the defence sweep proved it.** Raising the defended capacity
shrinks `O = (Q − Q_defended)·T` until the budget does bind — at Nagano ×2 it holds 287 reaches, at
Joso ×5 it holds 230 with a tightest supportable share of 0.20, at Mabi ×5 it holds 42 at a share
of 0.014. So the constraint fires exactly where the defences are set high enough to matter, which
is also where the score is already falling. It is a live safeguard on an unused part of the
parameter space, which is a fairer description than either "it works" or "it never fires".

### B — the excess formulation is continuous, and slightly worse

It does what it was designed to do. The cliff is gone (the unit tests assert a monotone ramp
against `channelDefenceMultiple` where the binary form is a step), and stage-pegged reaches fall
sharply — Joso 107 → 90, Mabi 72 → 40, Nagano 95 → 60, Kuma 500 → 445 — so the rating curve is
being asked a question it can actually answer on flat ground.

None of that reaches the extent. Subtracting bankfull from a discharge 4–35× larger changes the
stage by very little, and the small reduction it does produce trims about as much true positive as
false positive: **−1.4 points of hit rate bought −0.2 of over-prediction**. Precision is not
where the excess formulation acts, because precision here is dominated by mapping every river's
whole floodplain instead of one breach plume.

### C — areal reduction is correct and, today, inert

The factor itself is right and unit-tested against the worked values in §4. Its effect on extent is
under 0.1% (Mabi 107.8 → 107.9 km², every other site unchanged) for a structural reason: with the
stage solved for the total discharge, bankfull capacity reaches the extent only through the defence
gate, and no reach at any of the four sites is inside its defences. **C has no path to the answer
until B ships.** It corrects a bias that points in the unsafe direction, which is a real argument
for it, but the plan is explicit that correctness alone does not ship a change, so it stays opt-in
and the bias stays in the stated limitations.

## 9. Reproducing this

The whole campaign is four ERA5 archive calls and about twenty minutes of wall clock.

```
GEO_DATA_MODE=live PORT=9090 GEO_CACHE_TTL_FLOOD_MS=1 bun run server/index.ts
bun score.ts        # P6: baseline, A, B, C, AB, AC, BC, ABC over the four events
bun defence.ts excess   # P7: channelDefenceMultiple x1 to x12, continuous formulation
```

The climatology is cached to disk under `CLIMATE_CACHE_DIR`, so those four calls are needed once
and never again; a later run works entirely from `.cache/era5` and is unaffected by the archive's
daily cap. The harness warms all four sites before scoring anything and aborts if any run reports a
climatology fallback, because a fallback moves scored extent by ~2% and IoU by ~0.3 points and
would silently corrupt the comparison.

### The observed extents

GSI's surveyed inundation, one archive per event. These are the exact files behind every accuracy
figure in these specs:

| Event | Archive | Size | File used |
|---|---|---|---|
| Joso 2015 | `https://www.gsi.go.jp/common/000205781.zip` | 61 003 B | `常総地区の推定浸水範囲_201509111000.kml` |
| Mabi 2018 | `https://www.gsi.go.jp/common/000216844.zip` | 34 860 B | `…真備町の推定浸水範囲の変化_20180707.geojson` |
| Nagano 2019 | `https://www1.gsi.go.jp/geowww/201910/shinsui/shinsui_rinkaku.zip` | 5 330 283 B | `信濃川水系（千曲川）_20191018.geojson` |
| Kuma 2020 | `https://www1.gsi.go.jp/geowww/saigai/202007/shinsui/shinsui_rinkaku.zip` | 49 622 B | `球磨川（人吉周辺）_20200704.geojson` |

Extract preserving the Japanese filenames (`ditto -x -k` on macOS; `unzip -O UTF-8` elsewhere).
Observed areas should read 35.8, 8.9, 20.1 and 4.8 km²; the model is queried at each event's
observed-bbox centroid at 20 km radius, driven by the rainfall in §1a.

### The harness

Scoring is a 100 m lattice over the observed bounding box padded by 2 km and clipped to the query
circle; a point is a hit where it falls inside both an observed polygon and a returned zone. IoU,
POD and precision from those counts, then the unweighted mean over the four events. Land the survey
never covered is "not mapped", never "known dry", which is why the lattice stays inside the
surveyed footprint. Every scored request also compares the returned polygon area against
`inundation.floodedAreaKm2`, because a change that dilates the extent raises POD for free — the
ratio was 1.00× in all 60 runs behind this document.

**It still lives outside the repository, and this is the third time it has been rebuilt.** The
sources above make a rebuild an hour rather than a day, but committing it under `tools/` remains
the right answer before the next round of accuracy work.

> **Since resolved.** It was gone again, and rebuilt a fourth time as `tools/hindcast/`, where it
> now lives. It reproduces the baseline in §1a exactly. See
> [`plan-precision-profile.md` §2](./plan-precision-profile.md).

## 10. What this plan does not fix

Honest bounding, so the next reader does not expect more than is on offer:

- **The scoring ceiling is partly data, not physics.** The model floods every river's floodplain;
  the real events were single breach plumes. Without knowing which levee failed, that error is
  irreducible. OSM embankment coverage across the five sites ran 145–1 185 ways and its benefit
  tracked coverage exactly.
- **Nagano will stay poor** (IoU 10.7%, precision 12.1%). Its observed extent spans the whole
  Chikuma corridor across a municipal boundary; the scope mismatch is in the reference, not the model.
- **Timing is untouched.** Vectorisation and clipping are 76% of a 12.2 s request and cannot be
  coarsened without dilating the extent. A cheaper dissolve is a separate piece of work.
- **Fukui 2004 remains area-only.** No machine-readable observed extent exists, so it cannot
  contribute to any of the metrics above.
