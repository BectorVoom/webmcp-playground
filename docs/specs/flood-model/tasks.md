# Tasks — Coupled Pluvial–Fluvial Flood Model API

- **Status:** Complete through dynamic channel hydraulics
- **Last updated:** 2026-09-02
- **Inputs:** [`requirements.md`](./requirements.md) · [`design.md`](./design.md)

| Id | Task | Reqs | Status |
|---|---|---|---|
| T1 | Extract `priorityFlood` into `flow.ts`, shared with the pluvial spreader | R2.2 | ✅ |
| T2 | D8 receivers with pop-order flat resolution, flow accumulation, channel mask, reach slope | R2.2 | ✅ |
| T3 | Bankfull hydraulic geometry, Manning conveyance, overtopping assessment (`channel.ts`) | R2.3 | ✅ |
| T4 | Broad-crested weir breach with availability cap and spatial thinning (`breach.ts`) | R2.5 | ✅ |
| T5 | Catchment response: Hack length, Kirpich Tc, SCS unit-hydrograph delivery (`catchment.ts`) | R2.4 | ✅ |
| T6 | Extend `spreadRunoff` with per-cell `inflowM3` and depression `conveyanceM3`; conserve volume | R2.6, R2.7 | ✅ |
| T7 | Extract shared terrain/precipitation inputs (`flood-inputs.ts`); refactor the pluvial route onto it | — | ✅ |
| T8 | `POST /api/geo/flood-model` orchestrating all four processes, with pluvial baseline and diagnostics | R1.*, R3.*, R4.* | ✅ |
| T9 | Unit and route tests (66 + 14) | R2.7, R3.* | ✅ |
| T10 | Live verification at Fukui; fix inlet double-counting, off-channel injection, and basin-slope defects | R2.4 | ✅ |
| T11 | Storm sweep to characterise the saturation regime; record it as a stated limitation | R3.1, R3.2 | ✅ |
| T12 | Accuracy comparison against the GSI/MLIT L2 map, pluvial vs coupled | — | ✅ |

## Round two — driven by the five-event hindcast

| Id | Task | Status |
|---|---|---|
| T13 | DEM breaching: least-cost carving of spurious dams, after Lindsay (2016) (`flow.ts`) | ✅ |
| T14 | Robust depth reporting: `p99DepthMetres` beside the artifact-prone maximum | ✅ |
| T15 | Outlet-limited conveyance — a closed basin can no longer drain over its own rim | ✅ |
| T16 | HAND + synthetic rating curve for fluvial extent (`fluvial.ts`), replacing conveyance-limited ponding | ✅ |
| T17 | `upstreamRainfallMm`: the catchment's storm decoupled from the town's | ✅ |
| T18 | Shared `labelDepressions`; `spreadRunoff` exports labels and per-depression state | ✅ |
| T19 | Re-run the hindcast; confirm saturation gone and POD improved | ✅ |

Result: mean POD 38.8% → 49.7%, mean IoU 14.6% → 16.8%, precision unchanged (~20%);
saturation eliminated (fluvial contribution now holds from 100 mm to 800 mm);
reported depth at Joso 111 m → 9 m (p99) against 3.8 m observed.

## Round three — attacking precision

| Id | Task | Status |
|---|---|---|
| T20 | Available-volume check on the HAND stage (`overbankVolumeM3`) | ✅ implemented; binds on almost nothing |
| T21 | Flood-defence gate `channelDefenceMultiple`, calibrated over ×1–×12 | ✅ implemented; no leverage, ships at ×1 |
| T22 | Channel slope measured over 2 km rather than ten cells | ✅ implemented; ~0.1 pt effect |
| T23 | Diagnostics: reaches defended / stage-pegged / volume-limited | ✅ |
| T24 | Diagnose why none of it helped | ✅ channel capacity understated 2–4 orders of magnitude |

Outcome: mean IoU 16.8% → 17.3%, precision 20.6% → 21.4% across the defence
sweep — inside the noise. The measurement that explains it is in
[`design.md` §6](./design.md): peak discharges of 3 282–13 399 m³/s against
implied bankfull capacities of 0.6–16.5 m³/s, with essentially every reach over
capacity. Precision cannot improve until `channelGeometry` is valid at these
catchment sizes.

## Round four — real embankment data

| Id | Task | Status |
|---|---|---|
| T25 | Survey defence datasets: USACE NLD (US only), GSI `lcmfc2` (Japan, colour raster), OSM (global vector) | ✅ OSM chosen |
| T26 | `levee.ts`: Bresenham rasterisation to crest elevations; reach-restricting flood fill; breach openings | ✅ |
| T27 | `levee-source.ts`: Overpass fetch through the proxy, best-effort with reported status | ✅ |
| T28 | Per-call timeout override on `GeoProxyService.fetchUpstream` (Overpass needs tens of seconds) | ✅ |
| T29 | Route wiring: `useLevees`, `leveeHeightM`, `demBreachMinDepthM`, defence diagnostics | ✅ |
| T30 | Re-validate against the four events, defences on vs off | ✅ IoU 16.8% → 16.9%, precision 20.6% → 20.8% |
| T31 | Test whether the pluvial field is spurious shallow ponding | ✅ **rejected** — aggressive breaching is much worse |

The defence benefit tracks OSM coverage exactly (Mabi 1 185 ways: +0.3 IoU,
+0.8 precision; Kuma 145 ways: no change) — the method is correct and
data-limited. Aggressive DEM breaching was tried and rejected: shallow basins on
a leveed plain are real flood compartments, not artifacts, and carving them open
took Joso from 16.3% to 9.4% IoU. See [`design.md` §7](./design.md).

## Round five — the channel-geometry defect

| Id | Task | Status |
|---|---|---|
| T32 | ERA5 daily-precipitation archive as a climatology source (`climate-source.ts`), allowlisted, best-effort | ✅ 66 years at every site |
| T33 | Gumbel return levels and mean annual flood (`catchment.ts`) | ✅ |
| T34 | Discharge-keyed hydraulic geometry, Moody & Troutman (`channel.ts`); bankfull discharge used directly as capacity | ✅ |
| T35 | Area-keyed route retained as a reported fallback when climatology is unavailable | ✅ |
| T36 | Seed upstream catchment area at the inlets; size channels from the total catchment | ✅ removed a residual 1 181× artifact |
| T37 | Tests: Gumbel by hand, mean annual flood magnitude, W/D velocity consistency across 5 orders, capacity slope-independence, ERA5 parsing and degradation | ✅ 936 tests |
| T38 | Re-measure the defect, and re-calibrate the defence gate against it | ✅ |

Ratios corrected from 356–12 640× to **4–35×**, trunk bankfull now 244–1 182 m³/s.
Scored accuracy unchanged (mean IoU 16.8%, POD 48.3%) — capacity turns out not to
be on the critical path for extent, which is set by the HAND rating curve. The
diagnostics are now physical, and the defence gate discriminates for the first
time (best at ×2, still within noise of ×1, so the conservative default stands).
See [`design.md` §8](./design.md).

## Round six — performance

| Id | Task | Status |
|---|---|---|
| T39 | Diagnose the remaining accuracy ceiling: roughness and inflow sweeps | ✅ neither is a fixable cause; the ceiling is data-limited |
| T40 | Bounded LRU for DEM tiles, climatology and embankments (`static-cache.ts`), with test reset | ✅ |
| T41 | Share one Priority-Flood surface per request (6 passes → 2) | ✅ spreading 2 s → 70 ms |
| T42 | Byte-identity test for the shared-surface path | ✅ |
| T43 | Per-stage `timingsMs` in the response | ✅ |
| T44 | Coarsen vectorisation | ❌ **rejected** — dilates the extent 1.55x at 2x cell |

Warm request 20.9 s → **12.2 s**, results unchanged (mean IoU 16.8%, POD 48.4%,
precision 20.7% before and after; polygon/grid area agreement 1.00x). See
[`design.md` §9](./design.md).

## Round seven — stage reconciliation and areal reduction

Planned in full, with acceptance criteria and a stop rule, in
[`plan-stage-reconciliation.md`](./plan-stage-reconciliation.md).

| Id | Task | Status |
|---|---|---|
| P1 | Lock a baseline: four events at default settings, committed as numbers | ✅ |
| P2 | Cumulative available-volume constraint replacing the per-cell test (`fluvial.ts`) | ✅ |
| P3 | Storage accumulated along the network; `f` / `limit`; stage read back down the rating curve | ✅ |
| P4 | Rating curve solved for `Q − Q_defended`, with the total-Q path kept behind a flag | ✅ |
| P5 | `arealReductionFactor` (Leclerc & Schaake 1972) applied in `meanAnnualFloodM3PerS` | ✅ |
| P6 | Hindcast each workstream separately, then combined | ✅ eight configs |
| P7 | Re-calibrate `channelDefenceMultiple` against the continuous formulation | ✅ ×1 stands |
| P8 | Update `limitations`, `design.md`, `geo-sources.md`; delete falsified claims | ✅ |

**All three changes failed the stop rule and none ships as a default.** Mean IoU 16.8% → 16.8% (A,
cumulative volume), 16.5% (B, excess discharge), 16.8% (C, areal reduction), and 16.6% with all
three applied, against a bar of one full point. Re-sweeping `channelDefenceMultiple` against the
now-continuous formulation found IoU falling monotonically from ×1 (16.6%) to ×12 (11.9%), so the
existing ×1 stands — no longer as the conservative end of a sweep that could not discriminate, but
as a measured optimum. Each change is available as a request flag; the defaults are exactly where
round six left them.

What the measurement bought instead of a score:

- **The volume budget is now reported, not merely computed.** `network.volumeBudget` says on every
  request whether the mapped water surface is one the river could have filled. At Joso the storm put
  1.0 km³ past the main stem against 0.42 km³ of mapped storage — the constraint cannot bind because
  a whole-event throughput is not a storage. That is the diagnosis the previous two rounds lacked.
- **The excess formulation removes the cliff and un-pegs the rating curve** (stage-pegged reaches
  107 → 90, 72 → 40, 95 → 60, 500 → 445) without reaching the extent, because subtracting bankfull
  from a discharge 4–35× larger barely moves a stage.
- **A measurement hazard was found and closed.** The ERA5 climatology is best-effort, and a silent
  fallback swaps trunk bankfull from 244–1 182 m³/s to 23–50 — enough to change the scored extent by
  2% and IoU by 0.3 points. Two of the four sites had been scored through it before the harness was
  made to refuse such a run.
- **The volume budget is a live safeguard over an unused part of the parameter space.** It reads
  zero at the shipped defence multiple because the storm delivers 2.0–7.8× more water than the
  mapped surface needs, but holds 230–287 reaches once defences are raised to ×2–×5. "Never fires"
  was too strong; "fires only where the score is already worse" is the accurate statement.
- **One worked value in the plan was wrong.** The areal reduction factor at 5 000 km² / 24 h cannot
  be 0.89; the formula flattens at 0.912.
- **The reference data and harness were rebuilt from nothing and reproduce exactly.** The four GSI
  archives download byte-identical, and `baseline` returns the round-six numbers to the decimal at
  all four sites. The download URLs are now recorded in the plan so this is an hour's work rather
  than a day's.

The campaign is four ERA5 archive calls and about twenty minutes; see
[`plan-stage-reconciliation.md` §9](./plan-stage-reconciliation.md) for the commands, the archive
URLs and the scoring method.

## Mapped infrastructure — dams, storm drainage, and buildings

| Id | Task | Reqs | Status |
|---|---|---|---|
| I1 | One best-effort, disk-cached Overpass source for dams, drainage and building relations, with partial/failed status preserved | R2.6b–d, R3.4 | ✅ |
| I2 | Supersampled footprint raster, continuous dam/drain burns, and drain service dilation (`infrastructure.ts`) | R2.6b–d | ✅ |
| I3 | Route through finite mapped-reservoir storage upstream-to-downstream without double-counting cascades | R2.6b | ✅ |
| I4 | Remove only local runoff, capped by mapped storm-drain event capacity; preserve generated/captured/surface mass balance | R2.6c, R2.7 | ✅ |
| I5 | Apply building storage displacement to combined and attribution depth fields, with a bounded multiplier | R2.6d | ✅ |
| I6 | Route validation, cache-key isolation, diagnostics, limitations, and opt-out controls for all three effects | R1.*, R3.*, R4.* | ✅ |
| I7 | Unit and endpoint tests for parsing, rasterisation, capacity caps, dam retention, and observable model effects | R2.7, R3.* | ✅ |
| I8 | Four-event precision verification with complete mapped inputs | R4.2–3 | **1/4 admissible** — Joso measured; Mabi capped and Nagano/Kuma pending after Overpass failures. See [`plan-infrastructure-precision.md`](./plan-infrastructure-precision.md). |

## Dynamic channel hydraulics — arrival, momentum, and backwater

| Id | Task | Reqs | Status |
|---|---|---|---|
| D1 | Convert routed event volume into per-reach SCS peak, arrival, and peak time (`dynamics.ts`) | R2.3 | ✅ |
| D2 | Include shallow-water characteristic speed in the hydraulic travel time | R2.3a | ✅ |
| D3 | Reconcile local HAND stages with subcritical standard-step friction and velocity head | R2.3a | ✅ |
| D4 | Preserve the true event-volume budget while stage is driven by the short-lived peak | R2.7–2.8 | ✅ |
| D5 | Add response diagnostics, cache isolation, validation, limitations, and `dynamicRouting: false` control | R1.*, R3.* | ✅ |
| D6 | Analytical unit tests and full route regression suite | R2.3a, R2.7 | ✅ |
| D7 | Hindcast dynamic default against the locked steady control | R4.* | 🔄 measurement in progress |

## Follow-ups

- ~~**Commit the hindcast harness.**~~ ✅ Done, on the fourth rebuild: `tools/hindcast/`. It
  reproduces the locked baseline exactly, verifies the observed archives byte for byte, caches model
  responses so analysis can be iterated without re-running, and refuses to score a run whose
  climatology or embankment coverage silently degraded. See
  [`tools/hindcast/README.md`](../../../tools/hindcast/README.md).
- ~~**Persist the rainfall climatology to disk.**~~ ✅ Done: the annual-maximum series is kept under
  `CLIMATE_CACHE_DIR` (default `.cache/era5`), so a location is fetched once and read back
  afterwards, and a run made while the archive's daily cap is exhausted still takes the ERA5 path
  rather than degrading to a capacity an order of magnitude out. `climatology.retrievedFrom`
  reports `archive`, `stored` or `none`.
- **Precision is still the binding problem**, not recall: four fifths of the predicted extent did
  not flood, and round seven did not move it. Round eight profiled it rather than attacking it
  again, and narrowed what is left — see
  [`plan-precision-profile.md`](./plan-precision-profile.md). The over-prediction is not a fringe
  (roughly half of it is more than a kilometre from anything that flooded), not owned by either
  mechanism, and not removable by any depth or pond filter. With the stage chosen by hindsight,
  precision on this DEM never exceeds 34% at any site, so **no rating-curve work reaches the 28%
  target**; what stage work can still buy is hit rate. Near a confluence the regional network can
  still attribute a neighbouring river system to the query point. Round nine then spent the
  stage-allocation headroom the ceiling had priced ([`plan-stage-smoothing.md`](./plan-stage-smoothing.md)):
  mean precision now stands at 23.8% against that ~25% method bound, and the next precision step is
  the finer DEM, not the stage.
- ~~**Compound rating curve.**~~ ✅ Shipped in round eight. The curve applied one Manning n to the
  channel and its floodplain alike; it is now a compound section, roughnesses blended over the
  wetted perimeter, floodplain default 0.10. Mean IoU 16.8% → **18.2%**, hit rate 48.3% → **56.9%**,
  precision 20.7% → **21.2%**, every site improved, poly/grid 1.00×.
  [`plan-precision-profile.md` §7](./plan-precision-profile.md). The roughness is a literature value,
  not a calibrated one — these four events cannot identify it, since the score rises monotonically
  past the edge of the physical range.
- ~~**Along-channel stage smoothing.**~~ ✅ Shipped in round nine. The pegged-ladder hypothesis was
  profiled first and falsified (pegged reaches own 2.7–10% of the fluvial error; at Hitoyoshi their
  water is the model's best); the per-reach noise diagnosis stood, and the solved stage is now
  averaged over 500 m of river the way `downstreamSlope` treats the slope, pegged reaches borrowing
  their neighbours' consensus. Mean IoU 18.2% → **22.1%**, hit rate 56.9% → **75.5%**, precision
  21.2% → **23.8%**, every site improved on every metric, poly/grid 1.00×; unlike the roughness the
  window has a measured interior optimum (Hitoyoshi collapses past 500 m, so the events identify
  the value). [`plan-stage-smoothing.md`](./plan-stage-smoothing.md). Set `stageSmoothingM: 0`
  (harness config `unsmoothed`) to reproduce round eight exactly.
- **The breach planner does not find breaches.** At Joso, the one site whose survey records where
  the levee failed, all three predicted breaches land 19-20 km away. Either it earns its place or
  it should stop being reported as if it located anything.
- **Give the volume budget a residence time.** Round seven established that a whole-event volume
  budget cannot bind because it compares a 48 h throughput against a storage. Credited over a
  floodplain residence time of hours it would bind hard — at Joso a 6 h window puts the supportable
  share at ~0.30. Nothing in the model currently determines that time, which is exactly why it was
  not invented here.
- **Finer floodplain DEM.** Most of the residual gap against official maps is resolution, not
  physics; national LiDAR where published would close more of it than any further process. Round
  eight bounds the prize and gives the test: re-run `tools/hindcast/ceiling.ts` on a 5 m GSI DEM and
  see whether HAND discriminates any better than the 34% precision ceiling it has on Terrarium.
- **Expose as a WebMCP tool** alongside the existing `disaster.flood_forecast`, keeping the model
  estimate visibly distinct from authoritative hazard maps.
- **Spatially varying curve number** from land cover, shared with the pluvial endpoint.
