# Design — Coupled Pluvial–Fluvial Flood Model API

- **Status:** Implemented
- **Last updated:** 2026-09-02
- **Inputs:** [`requirements.md`](./requirements.md)

## 1. Pipeline

```
POST /api/geo/flood-model
        │
        ├─ Precipitation ── Open-Meteo forecast or design storm      [flood-inputs.ts]
        ├─ Terrain ──────── Terrarium DEM mosaic → despike → breach spurious
        │                   depressions                    [flood-inputs.ts, flow.ts]
        │
        ├─ Infrastructure ─ OSM dams + storm drainage + buildings → grid
        │                   lines, service area, footprint fraction
        │                         [infrastructure-source.ts, infrastructure.ts]
        ├─ Permanent water  OSM lakes/reservoirs → reservoir storage + mask
        │                                                    [water-source.ts, water.ts]
        │
        ├─ Network ──────── priorityFlood → d8Receivers → flowAccumulate(area)
        │                   → channelMask → downstreamSlope                [flow.ts]
        │
        ├─ Channel inflow ─ coarse regional pass (3x radius, z10):
        │                   priorityFlood → d8 → accumulate(area)
        │                   → findInlets (deduped along-river)             [flow.ts]
        │                   → deliverableInflow (Hack → Kirpich → SCS UH)  [catchment.ts]
        │                   → snapToDrainage → inflowM3[cell]
        │                   driven by upstreamRainfallMm, which may differ
        │                   from the rain over the town itself
        │
        ├─ Storm drainage ─ finite capacity removed from served local runoff
        ├─ Routing ──────── runoff + inflow, accumulated upstream → downstream
        │                   with finite mapped-reservoir retention at dams
        │                   event volume → SCS peak + arrival; characteristic
        │                   speed u + sqrt(g h)                       [dynamics.ts]
        │                   channelGeometry (Bieger) + Manning → capacity  [channel.ts]
        │                   assessOvertopping → Q/Qcap per reach
        │
        ├─ Breaches ─────── planBreaches (weir, capped by channel excess)  [breach.ts]
        │
        ├─ Pluvial ──────── spreadRunoff: fill-and-spill in closed basins,
        │                   outlet-limited conveyance                     [spread.ts]
        ├─ Fluvial ──────── heightAboveDrainage → synthetic rating curve →
        │                   standard-step momentum/backwater profile →
        │                   stage → depth below the water surface [fluvial/dynamics.ts]
        │                   combineDepths: the deeper of the two, per cell
        ├─ Buildings ────── footprint fraction displaces sub-grid storage →
        │                   open-area depth                    [infrastructure.ts]
        │
        └─ Extent ───────── bands → per-tile grids → rasterTilesToFloodZones
                            → clipAndMergeZones                     [bands/contour/clip]
```

## 2. Two mechanisms, because one cannot do both jobs

Pluvial ponding and river flooding are different physics and the model computes
them separately, then reports the deeper of the two per cell — never their sum,
since a cell under three metres of river is not also under its own rainfall.

**Pluvial** is volume-conserving fill-and-spill (`spread.ts`): rain runs downhill
and fills closed basins, and a basin drains at whatever its **outlet** can carry.
Reading conveyance at the outlet rather than anywhere inside the basin is what
stops a closed bowl with rivers running into it from draining uphill over its own
rim.

**Fluvial** is stage-based (`fluvial.ts`). It has to be: fill-and-spill is a
steady-state method, and in steady state a floodplain with an outlet stores
nothing, so a volume model can only ever inundate closed basins. Rivers inundate
floodplains through *unsteady* storage — the flood peak spreading sideways for
hours — which a maximum-envelope map cannot express as one settled volume. So
the river gets a water surface instead: HAND measures every cell against the
reach it drains to, a timed peak and rating curve convert that reach's event
volume into a stage, and everything below the event-maximum stage is wet.

The other processes feed those two. **Routing** produces the discharge the rating
curve reads, **channel inflow** adds the upstream catchment's water at the
inlets, **dams** retain a finite routed volume, **storm drainage** removes a
finite local runoff volume before either mechanism sees it, **buildings**
displace the storage available within a coarse grid cell, and **breaches** report
which reaches fail and with what outflow.

### 2.1 Arrival, momentum, and backwater

`dynamics.ts` adds time and longitudinal hydraulics without pretending the DEM is
a surveyed 2-D mesh.

For each reach, routed event volume is converted to an SCS triangular-hydrograph
peak. Time to peak is the storm centroid plus the slower of the Kirpich catchment
lag and the characteristic travel time derived from `u + sqrt(g h)`. The latter
is the downstream shallow-water characteristic, so inertia and gravity-wave
propagation affect when the peak reaches a point. Peak flow is never permitted
below delivered volume divided by event duration: external catchment delivery
has already been clipped to water that crosses the window during that duration,
and a lower peak would contradict the conserved volume.

The synthetic rating curve first supplies local normal stages. Those are then
walked from downstream receivers to upstream donors with the standard-step
energy balance

`z_u + y_u + v_u²/(2g) = z_d + y_d + v_d²/(2g) + h_f`.

`h_f` is the mean Manning friction slope over a reach. A downstream control can
only raise the independently solved upstream stage, only while the two peaks
overlap, and only through subcritical flow; a supercritical reach cuts the
backwater chain. The boundary time is carried with the profile, so pairwise
overlapping peaks cannot create a basin-wide water surface whose ends never
occurred simultaneously. A 20 m cap is retained and reported rather than
allowing an unresolvable profile to look precise.

This is deliberately a 1-D peak-envelope correction. It captures arrival,
velocity head and downstream control at the resolution the inputs support, but
does not claim time-indexed floodplain flow, reverse flow, hydraulic jumps,
bridge contractions or wall/street velocities. `dynamicRouting: false` keeps the
former event-average independent-reach path available as the locked hindcast
control. Arrival and characteristic-speed momentum are on by default;
`backwater: true` opts into stage propagation. The latter is not the default:
the matched four-event hindcast shows that these coarse synthetic sections turn
it into a much too generous boundary condition.

## 3. Three defects the live run exposed

All three were invisible in unit tests and obvious against real terrain at Fukui.

| Symptom | Cause | Fix |
|---|---|---|
| 10 inlets, 4705 km² upstream (true ≈ 1000) | A meandering river crosses a *circular* boundary many times; every inward crossing looked like a separate inlet | `findInlets` walks each candidate downstream and rejects it if it meets an already-accepted inlet — same river, already counted |
| Overtop ratio 2159 on a 10 km² headwater | Inlets are found on the coarse grid; mapping to the fine grid missed the channel and dropped a river onto the bank beside it | `snapToDrainage` moves the injection to the largest contributing area within a few cells |
| Tc = 71.7 h for a 976 km² basin | Kirpich wants the *basin-average* channel slope; it was given the local slope on the flat valley floor | `flowAccumulateMax` over elevation gives headwater relief, and slope = relief / Hack length. Tc → 10.8 h, Qp → 2584 m³/s |

## 4. Two rebuilds the hindcast forced

Validation against five real Japanese flood disasters (see §5) broke two parts of
the original design, and both were replaced rather than tuned.

**Conveyance was the wrong mechanism, and the outlet is what limits a valley.**
Conveyance was first taken as the *maximum* over a depression's cells, which let
a closed basin with rivers draining *into* it pass water out over its own rim. It
is now read at the depression's **outlet**: a river valley gets the capacity of
the reach carrying the river out, a closed basin gets the saddle on its rim,
which carries nothing. That is the physically correct reading and it is what the
fixture terrain exposed.

**A steady-state model cannot produce river flooding at all.** Fill-and-spill
answers "where does water come to rest", so a floodplain with an outlet stores
nothing and only closed basins inundate. Adding floodplain conveyance did not fix
this — it flipped the model from flooding everything to flooding nothing. Real
river floods inundate through *unsteady* storage, which a model with no time axis
cannot represent as volume. Fluvial extent is therefore now computed as a
**stage**: HAND plus a synthetic rating curve built from the terrain around each
reach (`fluvial.ts`), and the reported depth is the deeper of the pluvial and
fluvial fields per cell — never their sum.

**DEM breaching** (`breachSpuriousDepressions`) carves an outlet through dams the
DEM invents where it cannot resolve a gorge, after Lindsay (2016). A path is
accepted only within `maxLengthCells`, which is what separates an unresolved
gorge a few cells thick from a real caldera. At Joso it opened 433 depressions
and carved 5 327 cells.

## 5. Verification


**Live hindcast of five heavy-rain disasters, 20 km radius**, driven by the
observed event rainfall and scored against GSI's mapped inundation inside the
surveyed footprint (land GSI never surveyed is "not mapped", not "known dry"):

| Event | Rain used | Observed | IoU | POD | Precision |
|---|---|---|---|---|---|
| 2015 Kinugawa, Joso | 490 mm/48 h basin-avg | 35.8 km² | 16.2% | 45.8% | 20.1% |
| 2018 Oda R., Mabi | 342 mm/72 h Takahashi | 8.9 km² | 16.1% | 37.6% | 21.9% |
| 2019 Chikuma, Nagano | 196.8 mm/48 h basin-avg | 20.1 km² | 10.8% | 51.0% | 12.1% |
| 2020 Kuma R., Hitoyoshi | 322 mm/12 h basin-avg | 4.8 km² | 24.1% | 64.4% | 27.8% |

Against the conveyance-only model this is mean POD 38.8% → **49.7%** and mean IoU
14.6% → **16.8%**, at unchanged precision (~20%). The model now finds about half
of what actually flooded; roughly four fifths of what it calls flooded did not.
Area is over-predicted several-fold at every site, partly scope (a 1257 km²
circle against a district-scale survey) and partly the generosity of stage-based
mapping.

**Saturation, the defect the first hindcast exposed, is gone.** The fluvial
contribution used to collapse to zero above ~300 mm; it now holds across the
whole range, and depth rises monotonically with rainfall:

| Rain | Flooded | Pluvial only | Fluvial only | p99 depth |
|---|---|---|---|---|
| 100 mm | 208.4 km² | 90.1 | 147.2 | 5.72 m |
| 300 mm | 282.8 km² | 198.4 | 182.2 | 8.00 m |
| 800 mm | 323.9 km² | 235.2 | 223.6 | 12.76 m |

**Depth reporting is now robust.** At Joso the single deepest cell still reads
111 m — a basin with no short outlet, correctly left filled — while
`p99DepthMetres` reads 9 m against 3.8 m observed. Quote the percentile.

**Unit** (77 tests in `src/lib/hydrology`) and **route** (14 tests) as before,
plus: HAND measures each cell against the river it drains to and never goes
negative; stage, depth and extent all rise with discharge; a reach carrying
nothing gets no stage; a cell draining to no channel is never inundated;
breaching carves through a thin dam, leaves a genuine crater alone, and never
raises ground; a closed basin gets no conveyance however large the river draining
into it.

## 6-9. Rounds three to six, recorded in tasks.md rather than here

[`tasks.md`](./tasks.md) points at sections §6 to §9 of this file for the four
rounds of work after the first hindcast. Those sections were never written. The
record for them is the tasks file itself, and rather than reconstruct it here
after the fact, this is what each pointer means:

| Pointer | Round | Where it is recorded |
|---|---|---|
| §6 | Three — precision attacked through the volume check, the defence gate and the slope reach; none of it moved the score, and the diagnosis was that channel capacity was understated two to four orders of magnitude | [`tasks.md`](./tasks.md), "Round three" |
| §7 | Four — real embankments from OSM, and the rejection of aggressive DEM breaching (Joso 16.3% → 9.4% IoU) | [`tasks.md`](./tasks.md), "Round four" |
| §8 | Five — bankfull discharge from the ERA5 rainfall climatology, correcting the capacity defect from 356-12 640x to 4-35x | [`tasks.md`](./tasks.md), "Round five" |
| §9 | Six — performance, 20.9 s to 12.2 s, and the rejection of coarsened vectorisation | [`tasks.md`](./tasks.md), "Round six" |

## 10. Round seven — three corrections that were right and did not matter

Three defects in the stage calculation were identified, fixed, and measured
against the same four events. None of them moved the score, and the value of the
round is in what the measurements say rather than in what shipped. Planned and
recorded in full in [`plan-stage-reconciliation.md`](./plan-stage-reconciliation.md).

**The available-volume check was at the wrong scale, and fixing the scale did not
help.** It compared one channel cell's floodplain strip against the overbank
volume of the whole upstream river — loose by the ratio of river length to cell
length, which is why `reachesVolumeLimited` read zero everywhere. It is now
cumulative: storage accumulates along the drainage network, the supportable share
`f = min(1, O/cumS)` is computed per reach, the tightest downstream share
propagates upstream, and a limited reach is read back down its own rating curve.
It still reads zero on all four events, and the budget now reported with every
result says why: at Joso the storm delivered **1.0 km³ past the main stem against
0.42 km³ of mapped storage**. The test compares a 48 h throughput against a
storage, and assumes water that went overbank is still standing there. A volume
budget can only bind if it is credited over a floodplain residence time of hours,
which nothing in the model determines.

Because a safeguard that never fires is indistinguishable from one that is absent,
the budget is evaluated on every request and reported as `network.volumeBudget`
whether or not `volumeConstraint` lets it act.

**The defence gate was a step change, and the continuous form is slightly worse.**
Solving the rating curve for `Q − Q_defended` rather than `Q` makes extent grow
continuously from the moment defences are passed, and it un-pegs a third to a half
of the reaches the ladder could not solve (107 → 90, 72 → 40, 95 → 60, 500 → 445).
It costs 1.4 points of hit rate for 0.2 of precision, because subtracting bankfull
from a discharge 4–35× larger barely moves a stage. Available as
`stageDischarge: 'excess'`; the default stays `total`.

Re-sweeping `channelDefenceMultiple` against that continuous response was the last
thing that could have rescued the round, since the earlier ×1–×12 calibration had
been run against the step and a sweep cannot calibrate a discontinuity. It did
not: mean IoU falls monotonically from 16.6% at ×1 to 11.9% at ×12, buying 1.3
points of precision with 13 of hit rate on the way. **×1 stands, now as a measured
optimum rather than the conservative end of a sweep that could not discriminate.**

**Point rainfall overstates the catchment average, and correcting it is inert
today.** `meanAnnualFloodM3PerS` ran the point 2-year rainfall over the whole
catchment, overstating bankfull capacity and so understating flooding — the one
bias in the chain pointing the unsafe way. An areal reduction factor (Leclerc &
Schaake 1972, as used in NWS TP-29) now reduces it, taking only the storm duration
and catchment area already in hand. Its effect on extent is under 0.1%, because
with the stage solved for the total discharge capacity reaches the extent only
through the defence gate, and no reach at any of the four sites is inside its
defences. Available as `arealReduction`, off by default, and the bias is stated in
`limitations` instead.

**The volume budget is live, but over a part of the parameter space nobody should
use.** It reads zero at ×1 because the storm delivers 2.0–7.8× more water than the
mapped surface needs; raise the defended capacity to ×2–×5 and `O = (Q − Q_defended)·T`
shrinks until it holds 230–287 reaches, at supportable shares as low as 0.014. So
the constraint works and is simply slack where the model is actually run.

**A measurement hazard, found while locking the baseline.** The ERA5 climatology
is best-effort, and when the archive call fails the route falls back to area-keyed
hydraulic geometry. That swaps trunk bankfull from 244–1 182 m³/s to 23–50, which
moves scored extent by 2% and IoU by 0.3 points — enough to invalidate a
comparison, and nothing in the response made it obvious. The hindcast harness now
warms the climatology per site and refuses to score a run that took the fallback.
`reachesDefended` is the tell: 0 everywhere on the climate path, 10 and 1 398 on
the fallback.

## 11. Round eight — the error profiled instead of attacked

Five rounds had changed how the stage is chosen and the mean IoU had not moved, so this round
decomposed the error rather than proposing a sixth way. Recorded in full in
[`plan-precision-profile.md`](./plan-precision-profile.md); the harness that produced it is now in
the repository at `tools/hindcast/`.

**The over-prediction is not a fringe around the real flood.** Between 47% and 75% of the wrongly
flooded ground lies more than a kilometre from anything that flooded, and the model misses half of
what did. It is not a dilated truth, so "the stage is slightly too generous" was never the right
shape of explanation.

**Nothing filters it away.** Precision *falls* as the depth threshold rises (20.7% → 16.4% at 3 m):
the model's deepest water is its least accurate. Both mechanisms are independently wet over 21-41%
of the false-positive area, and eight filtering rules — drop a mechanism, drop deep cells, drop
whole deep ponds — move mean IoU by less than half a point each.

**The method has a measurable ceiling.** Standing every reach at one height and sweeping it
(`uniformStageM`) gives the best extent HAND on this DEM can produce with hindsight: mean IoU 21.5%
against 16.8% shipped, and precision that never exceeds 34.3% at any site at any stage. So 4.7
points of IoU remain available to better stage *allocation* — the solved stage is too low across
the floodplain that matters while flat reaches peg at the ladder limit — but **the 28% precision
target is unreachable by any rating curve on this terrain.**

**And one fix follows from it, which shipped.** The rating curve applied one Manning n to the
channel and its floodplain alike; 0.035 is a clean channel against a floodplain's 0.05-0.15, so the
floodplain conveyed too much and the curve settled too low — worst on exactly the wide shallow
sections that dominate the error. It is now a **compound section**: the two roughnesses are blended
over the wetted perimeter (Horton 1933; Einstein 1934), the channel keeps `manningN` and the
floodplain gets `floodplainManningN`, default 0.10 from Chow (1959) table 5-6.

The alternative formulation — sum two sub-section conveyances (Chow 1959 §6), available as
`compoundMethod: 'divided'` — scores the same in IoU at the same n, but splitting adds conveyance
before roughness enters, so its n is not the literature's n. That is why the blend is the default.

**Current accuracy**, four events with surveyed extents, against the single-section curve every
earlier figure in this file was measured with:

| Event | IoU | POD | Precision |
|---|---|---|---|
| 2015 Kinugawa, Joso | 16.3% → **17.1%** | 45.2% → 50.5% | 20.4% → 20.5% |
| 2018 Oda R., Mabi | 16.1% → **18.1%** | 36.1% → 44.1% | 22.5% → 23.6% |
| 2019 Chikuma, Nagano | 10.7% → **11.0%** | 48.3% → 54.3% | 12.1% → 12.1% |
| 2020 Kuma R., Hitoyoshi | 24.0% → **26.6%** | 63.8% → 78.5% | 27.8% → 28.7% |
| **mean** | 16.8% → **18.2%** | 48.3% → **56.9%** | 20.7% → **21.2%** |

Every site improves, which no round since the second managed. The roughness is a stated assumption
rather than a fitted one: swept against these four events the score climbs monotonically to the edge
of the physical range and past it, so they cannot identify a value and it is taken from the
literature. Set `floodplainManningN` equal to `manningN` to reproduce any figure recorded before
this round exactly.

## 12. Round nine — the stage smoothed along the river

Round eight's ceiling said the remaining stage headroom was allocation, not height: a constant
stage chosen with hindsight beat the solved field at three of four sites. Round nine profiled the
two candidate explanations and fixed the one left standing. Recorded in full in
[`plan-stage-smoothing.md`](./plan-stage-smoothing.md).

**The ladder cap was falsified first.** A new `fluvialPeggedZones` diagnostic (returned with
`componentZones`) scores the water under ladder-pegged reaches on its own: 2.7–10% of the fluvial
false-positive area at the plains sites — one or two km², nearly all wrong but too small to
matter — while at Hitoyoshi the pegged gorge water is the *best* water in the model (34.7%
precision). The 20 m cap was not the lever.

**The noise was.** Each reach solves its rating curve from only the strip of cells that happen to
D8-drain to it, so adjacent reaches on one river stand metres apart — variation a real water
surface, smooth over kilometres of gradually varied flow, cannot have. The solved stage now gets
the treatment `downstreamSlope` has always given the slope: `stageSmoothingM` (default 500)
averages it along the channel, downstream pairs contributing symmetrically. Pegged stages are
never lent out but do receive, so a lone pegged reach takes its neighbours' consensus instead of
20 m while a pegged gorge keeps its peg.

The window is a measured optimum, not a monotone knob: flat floodplains keep improving out to
4–8 km while Hitoyoshi collapses past 500 m (28.4% → 16.4% IoU), so 250–500 m is the only plateau
that improves every site, and 500 m stays a multi-cell window at every DEM zoom.

**Current accuracy**, against round eight's compound curve (`stageSmoothingM: 0`, the harness's
`unsmoothed` config):

| Event | IoU | POD | Precision |
|---|---|---|---|
| 2015 Kinugawa, Joso | 17.1% → **23.3%** | 50.5% → 82.5% | 20.5% → 24.5% |
| 2018 Oda R., Mabi | 18.1% → **25.9%** | 44.1% → 72.3% | 23.6% → 28.8% |
| 2019 Chikuma, Nagano | 11.0% → **11.2%** | 54.3% → 67.5% | 12.1% → 11.8% |
| 2020 Kuma R., Hitoyoshi | 26.6% → **28.1%** | 78.5% → 79.8% | 28.7% → 30.3% |
| **mean** | 18.2% → **22.1%** | 56.9% → **75.5%** | 21.2% → **23.8%** |

Mean IoU clears the 21.5% uniform-stage ceiling of §11 — legitimately, since that ceiling bounded
constant allocation and a smoothed field is not constant. Depth bands also mean the right thing
now: precision rises with the reported depth (23.8% → 26.6% keeping high+) where it used to fall.

## 14. Round ten — the reference, and the DEM

Two candidate explanations for the standing gap were measured together, on the same events and the
same lattice points. Recorded in full in
[`plan-reference-and-dem.md`](./plan-reference-and-dem.md).

**The reference was the larger constraint by a factor of thirty, and a control settles it.** Every
figure above scores an envelope against *one event's surveyed extent*. Scoring MLIT's official
洪水浸水想定区域 the same way — as if the national hazard map were a prediction of that one event —
returns **25.2% mean precision at 99.0% POD**. The official product is not inaccurate; it is an
envelope being charged for ground that particular flood did not occupy. Precision against a single
event is therefore bounded near 25% for any envelope product, and **56.7% of this model's "false
positives" sit inside officially designated flood-prone ground**. Scored against that envelope
instead, on identical points, the model reads **67.1% precision (68.2% on the national DEM, 81.3%
at Joso)**.

**The DEM is real but small.** Three arms separate resolution from information: halving the cell
size on the same SRTM moves precision 0.2 points, while swapping in Japan's national 10 m survey at
*identical* cell size moves it 1.3 (23.8% → 25.3% vs event; 67.1% → 68.2% vs envelope). `demSource`
selects `terrarium` (default, worldwide), `gsi10` or `gsi5`; the wider context window stays global
in every arm so upstream inflow is held fixed. Terrarium remains the default because it is the only
tileset with worldwide coverage.

## 15. Round eleven — standing water is not flood

The model reads terrain and cannot tell a lake from low ground, so both mechanisms were drawn to
standing water and it reported Lake Nojiri as 2 km² of flood. `maskPermanentWater` (default true)
excludes mapped lakes, reservoirs and river channels from the reported extent, sourced from
OpenStreetMap through the same Overpass the embankments use and cached under `WATER_CACHE_DIR`.
Only the mapped normal pool is removed, so flooding beyond a shoreline survives; an outage degrades
to the older, more generous extent and says so in `permanentWater`.

Mean precision against the official envelope **68.2% → 73.9%** at unchanged hit rate (58.2% →
58.1%), and against the surveyed event extent 25.3% → 27.4%.

**Testing it outside Japan found a safety defect Japan could not expose.** OSM marks a seasonally
dry water body `intermittent=yes` — 47.8% of mapped water around Tucson against 5.6% at Joso — and
an intermittent body is land that floods, not water that is already there. The mask was deleting the
ephemeral washes that *are* the arid flash-flood hazard; excluding them restored 16% of the extent at
Tucson. How much the mask removes is strongly regional: 77% of the extent in the Finnish lake
district, 0.4% in the Arizona desert. Recorded in full in
[`plan-permanent-water.md`](./plan-permanent-water.md).

## 16. Round twelve — Nagano diagnosed, nothing shipped

Nagano's deficit changed shape once standing water was masked: its precision against the envelope is
now second best of the four, and its *hit rate* is the outlier at 38.7%. Hit rate across the four
sites tracks driving-storm depth in exact order (490 mm gives 85%, 197 mm gives 39%), because the
envelope is drawn for the L2 maximum-assumed-scale storm while the runs use each event's own
rainfall. Beyond that, a free stage reaches 74.7% hit rate at *higher* precision than the solved
curve, so the terrain is not the limit — the rating curve under-solves there, because 2 000 m of
basin relief gives the Chikuma four times Joso's modelled bankfull capacity on twice the catchment.

**No default changed.** Re-sweeping floodplain roughness against the envelope does buy +7.7 points
of hit rate at flat precision, which removes round eight's dilution worry — but the sweep is still
monotone to the edge of the validated range, which is the same reason round eight refused to
calibrate on it. Recorded with its price in [`plan-nagano.md`](./plan-nagano.md).

## 17. Round thirteen — the model outside Japan

For twelve rounds every accuracy figure here was Japanese, because Japan was the only place with an
open surveyed extent to score against. England has one too: the Environment Agency's **Recorded
Flood Outlines**, 31 696 surveyed extents served over WFS. Two events were scored against it with
`bun tools/hindcast/eu.ts`, on the same 100 m lattice and the same metrics as the Japanese four.

The storm forcing is the weak link and is treated as such. The Japanese events are driven with
totals from official post-event reports; there is no equivalent figure to hand for these, so both
are driven with ERA5 at the query centre — a 0.25° reanalysis that under-catches orographic rain
badly (29 mm for the day Storm Desmond put a UK-record 341 mm on Honister Pass). A single score at
that forcing would measure the rainfall. So the rainfall is swept, and the reported row is the one
whose modelled **area** matches the survey: given about the right amount of water, does it go to
about the right places?

| Event | Prevalence | Rain | Model | Observed | Over | IoU | POD | Precision | MCC |
|---|---|---|---|---|---|---|---|---|---|
| 2015 R. Eden, Carlisle | 9.9% | 61.9 mm | 20.6 km² | 14.9 km² | 1.4× | **33.3%** | 59.5% | 43.1% | 0.442 |
| — best MCC | | 150 mm | 32.1 | 14.9 | 2.2× | 35.8% | 83.2% | 38.6% | **0.500** |
| 2007 Severn/Avon, Tewkesbury | 7.3% | 84.6 mm | 109.1 km² | 51.8 km² | 2.1× | **30.1%** | 71.8% | 34.1% | 0.439 |
| Japan, mean of four (§13) | 1.9–15.3% | official | — | — | 3–12× | 22.1% | 75.5% | 23.8% | — |

**The model scores better in England than in Japan**, on IoU and precision, at comparable hit rate.
Three things stop that being an artefact:

- **Prevalence is not flattering it.** The two English windows are 9.9% and 7.3% wet, inside the
  Japanese range of 1.9–15.3%. Carlisle (9.9%) and Mabi (9.4%) are nearly identical windows, and
  Carlisle beats Mabi on every metric — 33.3% against 25.9% IoU, 43.1% against 28.8% precision.
- **Over-prediction is smaller here**, 1.4–2.1× against Japan's 3–12×.
- **Every best-effort input resolved.** ERA5 climatology, OSM embankments and OSM standing water all
  reported `ok`, so `model.ts`'s three refusal guards passed and these are comparable runs.

The sweeps say different things about the two sites, and the difference is the useful part:

- **Carlisle behaves like a site given too small a storm, up to a point.** Hit rate climbs 30 points
  across the sweep while precision gives up only 13.5, and MCC *rises* from 0.442 to a peak of 0.500
  at 150 mm before falling. There is a real optimum, and it is well above the ERA5 forcing — which
  is what the Desmond rainfall record would predict.
- **Tewkesbury is already too wet at the smallest storm tested.** It over-predicts 2.1× at 84.6 mm
  and every metric decays monotonically from there. More rain never helps it, so its residual error
  is allocation, not forcing — the same diagnosis §11 reached for Japan.

Two limits on how far this generalises. **"Europe" here is England**: both events are English
because the EA service is the open machine-readable one, while Copernicus EMS Rapid Mapping — which
covers continental events — publishes shapefile packages through a JavaScript portal that nothing
here reads. And precision against a *single event's* survey is bounded for any envelope: §14
measured Japan's own official hazard map at 25.2% precision against these same surveys. Treat these
as regression tripwires and cross-region evidence, not as quality targets.

## 18. Mapped built infrastructure

The DEM cannot resolve a sewer pipe, a house footprint or the operating state of
a reservoir, but omitting all three makes the model systematically wrong in
built catchments. They are therefore represented as explicit sub-grid terms in
`infrastructure.ts`, fed by independent best-effort OpenStreetMap GET queries for
linear infrastructure and buildings in `infrastructure-source.ts`. A response
that hits its layer-specific element cap or gateway timeout is split along its
longer axis until every child is complete; child and merged geometry are kept
below `WATER_CACHE_DIR/infrastructure`, so a rate-limited pass resumes rather
than restarting. Cross-boundary ways are deduplicated. A
failed or still-truncated lookup is reported, is not kept in the whole-model
response cache, and is never converted into a confident empty world.

**Dams are finite storage in the routed event volume.** Connected mapped dam
cells are snapped to the largest drainage path nearby. A single downstream-first
pass assigns each mapped permanent-water cell to the first dam its D8 path
reaches; storage is that normal-pool area times the requested available drawdown
(0.5 m by default). A second upstream-first pass retains no more than that
capacity and routes the remainder on. Cascades therefore do not double-count a
reservoir, and a dam without a mapped reservoir gets zero invented protection.
This is deliberately not a gate schedule, observed initial level, controlled
release hydrograph, overtopping calculation or breach wave.

**Storm drainage is an event-capacity withdrawal from local runoff.** Mapped
`man_made=storm_drain`, storm/combined sewer ways, drains and culverts serve the
cells within 100 m by default. A served cell loses at most 15 mm/h over the event
and never more water than it contains. External channel inflow is added only
after this step, so a street inlet cannot drain a river. Sparse underground OSM
mapping makes the result conservative in many cities; the response reports the
mapped elements, served area and captured volume rather than hiding that gap.

**Buildings are porosity, not walls.** Footprints are sampled 8×8 within every
DEM cell so a ten-metre house does not disappear merely because it misses a
60-metre cell centre. Water that occupied a whole cell before structures is
placed in its open fraction, increasing depth by `1 / (1 − footprintFraction)`;
the blocked share is capped at 0.8 by default. This conserves the cell's sub-grid
storage without pretending a coarse D8/HAND grid resolves alleys, doors,
basements, individual wall flow paths or structural failure.

Unit tests pin rasterisation, capacity caps, storage conservation and dam
cascade routing. Route tests pin source reporting and show each enabled term
changes only its intended part of the model. The defaults are engineering
screening assumptions and have not yet been hindcast-calibrated; that limitation
travels in every response.

## 19. Follow-ups

- Conveyance is evaluated at bankfull, which under-drains in a large event and so over-predicts
  ponding. Over-prediction is the safe direction for a life-safety tool, but a stage-dependent
  compound-channel rating curve would be more faithful and would likely delay saturation. §11 now
  measures what the roughness half of that is worth.
- **Precision targets must name their reference.** §14 shows the same extent scoring 25.3% or 68.2%
  depending only on what it is compared against, so a bare percentage is not a specification.
- `gsi5` (5 m LiDAR) is implemented but unmeasured: at 20 km the grid budget degrades it to the same
  z12 as `gsi10`, so reaching it needs a smaller window and its own matched-radius control.
- **Score L2 envelopes with an L2 storm.** Driving each run with its own event rainfall and scoring
  against a maximum-assumed-scale envelope under-predicts hit rate by construction, worst where the
  actual storm was smallest. A harness fix, needing MLIT's published L2 rainfall per river system.
- **Floodplain roughness may be low.** 0.15 rather than 0.10 is worth +2.0 IoU and +3.3 POD at
  unchanged precision, and is inside Chow's range for a built-up floodplain — but it is a judgement
  about a physical constant, not something these four events can identify. See
  [`plan-nagano.md`](./plan-nagano.md) §5.
- **Bankfull on high-relief basins.** Nagano's trunk is modelled with 987 m³/s of in-bank capacity
  against Joso's 238; checkable against gauged rating curves rather than by sweeping.
- **Accuracy outside Japan was untested until round thirteen**, and is now measured for England
  only — see §18. The US remains untested: FEMA's NFHL is open but was unreachable from the
  development environment, and is covered by behaviour and safety tests alone.
- Precision is not comparable between sites and should not be averaged naively: prevalence runs from
  14% to 55% across these windows, and a perfect answer off by one 100 m cell scores 70.5% at Kuma
  against 87.7% at Joso. Normalised by that ceiling the model runs 92.6 / 85.6 / 84.5 / 70.4%, so
  only Nagano has a real deficit left — a third of its window is undesignated ground the reference
  has no opinion on, and 8.0% of its false positives lie beyond 3 km. See
  [`plan-reference-and-dem.md`](./plan-reference-and-dem.md) §7.
- The breach planner does not locate breaches: at Joso its three predictions land 19-20 km from the
  surveyed failure.
- Spatially varying curve number from land cover, shared with the pluvial endpoint.
