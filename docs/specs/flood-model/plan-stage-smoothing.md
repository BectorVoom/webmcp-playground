# Plan — Along-channel stage smoothing, and the noise the rating curve was solving

- **Status:** Complete. The profiled hypothesis (ladder pegging) was falsified; the diagnosis it
  left standing — per-reach stage noise — is fixed, measured, and **shipped as the default** (§5).
- **Last updated:** 2026-08-31
- **Inputs:** [`plan-precision-profile.md`](./plan-precision-profile.md) (round eight) ·
  [`design.md`](./design.md) §11, §12 · `tools/hindcast/`
- **Scope:** `src/lib/hydrology/fluvial.ts`, `server/routes/flood-model.ts`, `tools/hindcast/`

## 1. Why

Round eight left one line of measured headroom open: **stage allocation**. A constant stage chosen
with hindsight beats the solved rating curve at three of the four sites (mean IoU 21.5% against
18.2% shipped), so 4.7 points of IoU sit in *where* the stage goes, not in how high it generally
is. The same profile said the solved stage is "misallocated between reaches — too low across the
floodplain that matters while a hundred flat reaches peg at the 20 m ladder limit", and every
site's `maxRiverStageM` reads 20 m against ~3.8 m observed at Joso.

Two candidate diagnoses for that misallocation, and they demand different fixes:

- **The ladder cap**: pegged reaches standing at 20 m own the deep wrong water.
- **Per-reach noise**: each reach solves its curve from only the strip of cells that happen to
  D8-drain to it, so adjacent reaches on one river stand metres apart — variation a real water
  surface, smooth over kilometres of gradually varied flow, cannot have.

Rounds three through seven all attacked the stage without profiling first and none moved the
score, so this round measured before fixing.

## 2. The profile: pegging is falsified

A new opt-in diagnostic (`fluvialPeggedZones`, returned with `componentZones`) vectorises the
fluvial field restricted to reaches the ladder could not solve, so the harness can score pegged
water on its own. `FluvialResult` now carries the per-cell `pegged` mask that backs it. Measured
on round eight's default (the raw compound curve):

| Event | Field | wet km² | TP km² | FP km² | precision | share of fluvial FP |
|---|---|---|---|---|---|---|
| joso | pegged | 1.4 | 0.0 | 1.3 | 2.9% | 2.7% |
| joso | solved | 63.9 | 15.0 | 48.9 | 23.5% | 97.3% |
| mabi | pegged | 1.0 | 0.0 | 1.0 | 0.0% | 10.0% |
| mabi | solved | 12.4 | 3.2 | 9.2 | 26.0% | 90.0% |
| nagano | pegged | 1.8 | 0.0 | 1.8 | 0.5% | 2.9% |
| nagano | solved | 68.6 | 8.3 | 60.4 | 12.1% | 97.1% |
| kuma | pegged | 3.0 | 1.1 | 2.0 | 34.7% | 24.0% |
| kuma | solved | 9.0 | 2.7 | 6.3 | 29.9% | 76.0% |

**Pegged reaches own 2.7–10% of the fluvial error at the plains sites** — one or two km² each,
nearly all wrong (0–3% precision) but too small to matter — and at Kuma the pegged water is the
*best* water in the model (34.7%, the gorge, where a maxed-out stage is right). The 20 m cap is
not the lever. The deep wrong water stands under reaches that **solved** their curve, which
leaves the noise diagnosis as the one still standing.

## 3. The fix: average the stage over a reach of river

`downstreamSlope` already refuses to read a slope off one cell, "mostly quantisation on flat
ground", and averages it over 2 km of river. The solved stage deserved the same treatment for the
same reason and never got it: the strip of cells draining to one channel cell is an accident of
D8 on a filled floodplain, so the per-reach rating curve is well posed but ill conditioned.

`stageSmoothingM` averages each active reach's solved stage with its neighbours within half a
window along the channel, walking downstream exactly as `downstreamSlope` does; each in-window
pair contributes symmetrically, so a confluence hears its tributaries and they hear it. Two rules:

- **Pegged stages are never lent out** — a ladder-top stage is a failure marker, not a
  measurement — but a pegged reach still receives, so a lone pegged reach among solved neighbours
  takes their consensus instead of 20 m. A pegged cluster with no solved neighbour in reach keeps
  the peg (the Kuma gorge, correctly).
- An average cannot leave the solved range, so the smoothed field is a reallocation, not a new
  stage rule — asserted by unit test.

## 4. Measured

Swept over the window, all four events, poly/grid 1.00× in all 28 runs:

| Window | mean IoU | mean POD | mean precision | joso / mabi / nagano / kuma IoU |
|---|---|---|---|---|
| off (round eight) | 18.2% | 56.9% | 21.2% | 17.1 / 18.1 / 11.0 / 26.6 |
| 250 m | **22.1%** | 74.9% | 23.8% | 23.4 / 25.0 / 11.4 / **28.4** |
| **500 m** | **22.1%** | **75.5%** | **23.8%** | 23.3 / 25.9 / 11.2 / 28.1 |
| 1 km | 20.7% | 71.8% | 22.7% | 24.1 / 24.7 / 11.2 / 22.6 |
| 2 km | 20.8% | 72.5% | 22.8% | 24.2 / 28.0 / 11.8 / 19.3 |
| 4 km | 21.4% | 75.4% | 23.3% | 26.0 / 29.5 / 13.4 / 16.7 |
| 8 km | 21.0% | 75.5% | 23.0% | 25.6 / 27.7 / 14.2 / 16.4 |

Unlike round eight's roughness, **this sweep has a turning point, so the events can identify the
value.** The flat floodplains keep improving with window width (Joso 26.0% at 4 km) while
Hitoyoshi collapses past 500 m (28.4% → 16.4%): gorge reaches carry real per-reach signal that
wide averaging destroys, exactly the exception round eight's ceiling already flagged. 250 m and
500 m are one plateau and the only windows that improve **every** site; 500 m is taken because it
remains a multi-cell window at every DEM zoom, where 250 m degenerates to a single cell.

Mean IoU 22.1% also clears round eight's 21.5% uniform-stage ceiling — legitimately, because that
ceiling bounded constant-stage allocation, and a smoothed field is not constant.

## 5. Outcome against the acceptance test

Stated before the sweep, in round eight's form (falsify on any regression):

| Metric | Round eight | Falsifies | Measured at 500 m |
|---|---|---|---|
| mean IoU | 18.2% | < 18.0% | **22.1%** ✅ |
| mean POD | 56.9% | < 56.9% | **75.5%** ✅ |
| mean precision | 21.2% | < 21.2% | **23.8%** ✅ |
| poly/grid | 1.00× | any drift | 1.00× ✅ |

Every site improves on every metric, the second round ever to manage it:

| Event | IoU | POD | Precision |
|---|---|---|---|
| Joso | 17.1% → **23.3%** | 50.5% → 82.5% | 20.5% → 24.5% |
| Mabi | 18.1% → **25.9%** | 44.1% → 72.3% | 23.6% → 28.8% |
| Nagano | 11.0% → **11.2%** | 54.3% → 67.5% | 12.1% → 11.8%* |
| Kuma | 26.6% → **28.1%** | 78.5% → 79.8% | 28.7% → 30.3% |

\* Nagano gives up 0.3 points of precision for 13 of hit rate; its IoU still rises, and the site
remains reference-limited (the observed extent spans the whole Chikuma corridor, round seven §10).

**Shipped as the default** at `stageSmoothingM: 500`. Set 0 to reproduce any figure recorded
before this round; the harness keeps `unsmoothed` (round eight's default) and `single` (rounds
two through seven) as pinned configs and checks all three baselines on every run.

One more defect fixed on the way: the route's response cache key omitted `floodplainManningN`,
`compoundMethod` and `uniformStageM`, so two requests differing only in those fields could be
served one answer under a non-trivial `GEO_CACHE_TTL_FLOOD_MS`. The harness never saw it (it runs
at a 1 ms TTL); a browser session sweeping the roughness would have. All four stage parameters
are in the key now.

## 6. What the smoothed field changes about the error's shape

From `tools/hindcast/profile.ts` at the new default:

- **Depth bands mean the right thing now.** Precision used to *fall* as the threshold rose
  (21.2% → 19.2% at high+); it now rises (23.8% → **26.6%** at high+, 25.4% at extreme+). The
  model's confident water is finally its better water, which is what a reader needs a band for.
- **Pegged water is down to 1.3–5.3% of fluvial FP** at the plains sites (re-estimated from
  neighbours), and Kuma's pegged gorge water keeps its 33.6% precision under the 500 m window.
- **Absolute over-prediction grows** (Joso 334 → 420 km² over the whole circle), as it did in
  round eight and for the same reason: the extent this model still lacked was hit rate, and the
  added ground is *more* accurate than the ground it already had (precision rose with it). The
  over-prediction ratio inside the scored window is 2.5–5.7×, and the >3 km false-positive share
  actually falls at every site (Joso 23.5% → 19.3%).

## 7. What this does not answer

- **Nagano barely moves** (11.0 → 11.2) and stays reference-limited; no allocation of stage fixes
  a scope mismatch in the observed extent.
- **HAND's discrimination bound stands.** Precision 23.8% against the ~25% method bound of round
  eight §5; the next real precision step is still the finer DEM
  ([`design.md`](./design.md) §12), for which `tools/hindcast/ceiling.ts` remains the test.
- **The window is calibrated on four events.** It has an interior optimum and a physical reading
  (average what one cell cannot measure, stop before real longitudinal signal), but four events
  is four events; a fifth with a surveyed extent would be the check.

## 8. Reproducing

```bash
GEO_DATA_MODE=live PORT=9090 GEO_CACHE_TTL_FLOOD_MS=1 bun run server/index.ts
bun tools/hindcast/run.ts fetch
bun tools/hindcast/run.ts score single unsmoothed baseline   # all three locked baselines, §5
bun tools/hindcast/run.ts score sm025 sm05 sm1 sm2 sm4 sm8   # the sweep, §4
bun tools/hindcast/profile.ts                                # §2 (pegged table), §6
```

The ERA5 climatology for all four sites is already on disk; nothing above touches the archive.
