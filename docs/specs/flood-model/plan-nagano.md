# Plan — Optimising Nagano, and why nothing shipped

- **Status:** Complete, **no default changed**. The deficit is diagnosed and bounded; the only lever
  that reaches it is not one this repository's own rules allow to be calibrated here (§6). One
  finding worth acting on separately: round eight's floodplain roughness was chosen against a
  reference now known to be the wrong one (§5).
- **Last updated:** 2026-08-31
- **Inputs:** [`plan-reference-and-dem.md`](./plan-reference-and-dem.md) §7 ·
  [`plan-permanent-water.md`](./plan-permanent-water.md) · [`plan-precision-profile.md`](./plan-precision-profile.md) §7
- **Scope:** `tools/hindcast/storm-sweep.ts` (new); no source changes

## 1. The deficit changed shape

Nagano was the one site with a real gap after round ten: 70.4% of its geometric ceiling against
92–95% elsewhere. Round eleven's water mask took it to 79.5%, and in doing so **changed what is
wrong with it**:

| | POD vs envelope | precision vs envelope | IoU |
|---|---|---|---|
| joso | 85.4% | 83.6% | 73.1% |
| mabi | 58.3% | 74.8% | 48.7% |
| **nagano** | **38.7%** | **70.3%** | 33.3% |
| kuma | 49.9% | 66.8% | 40.0% |

**Nagano's precision is now second best of the four.** It is not putting water in the wrong places.
It is not putting enough water anywhere: its hit rate is the worst by eleven points.

## 2. Hit rate tracks the storm, not the site

The four events are driven with their own observed rainfall, and the envelope is drawn for the **L2
storm** (想定最大規模, the maximum assumed scale) — a far larger event than any of them. Scoring an
actual-event run against a maximum-assumed-scale envelope must under-predict, and by more where the
actual storm fell further below L2. Across the four sites, hit rate orders exactly as storm depth
does:

| Event | driving storm | POD vs envelope |
|---|---|---|
| joso | 490 mm / 48 h | 85.4% |
| mabi | 342 mm / 72 h | 58.3% |
| kuma | 322 mm / 12 h | 49.9% |
| nagano | **196.8 mm / 48 h** | 38.7% |

Nagano's 2019 storm was the smallest of the four by a wide margin. That is a property of the
comparison, not of the model.

## 3. But the storm is not the whole story

Sweeping the driving rainfall at Nagano (`tools/hindcast/storm-sweep.ts`), scored against the
envelope:

| rainfall | POD | precision | IoU | model km² |
|---|---|---|---|---|
| 150 mm | 35.5% | 68.9% | 30.6% | 93 |
| **196.8 mm (actual)** | 38.7% | 70.3% | 33.3% | 100 |
| 300 mm | 43.4% | 71.9% | 37.1% | 110 |
| 500 mm | 47.6% | 72.9% | 40.5% | 119 |
| 800 mm | 50.3% | 73.3% | 42.5% | 125 |

**Precision rises as the extent grows** — the added ground is better than the ground already there,
so this is the model approaching the envelope rather than flooding indiscriminately. But hit rate
saturates near 50%, and the extent grows only 34% for 4× the rain. Something else is binding.

## 4. The terrain is not the limit; the solved stage is

`uniformStageM` stands every reach at one height and skips the rating curve, which bounds what HAND
can produce here with the stage chosen freely:

| Nagano, vs envelope | POD | precision | IoU | model km² |
|---|---|---|---|---|
| shipped (solved curve) | 38.7% | 70.3% | 33.3% | 100 |
| uniform 7 m | 64.0% | 72.9% | 51.7% | 162 |
| **uniform 10 m** | **74.7%** | **72.0%** | **57.9%** | 191 |
| uniform 15 m | 84.2% | 69.1% | 61.2% | 226 |

**A uniform 10 m stage strictly dominates the solved curve on all three metrics at once** — hit rate
nearly doubles, precision *rises*, IoU nearly doubles. There is 191 km² of ground within 10 m of the
river at 72% precision, and the curve is finding 100 km² of it. The shipped configuration is not on
a trade-off frontier at Nagano; it is simply below the achievable set.

Ten metres is not an absurd stage to compare against, either: the official envelope at Nagano puts
60.7 km² in its 5–10 m band and 24.5 km² in its 10–20 m band. The L2 map itself describes water that
deep.

### Why the curve under-solves here

The route's own diagnostics, Nagano against Joso on the same DEM:

| | trunk catchment | trunk bankfull | peak discharge | max overtop ratio |
|---|---|---|---|---|
| nagano | 6 434 km² | **987 m³/s** | 5 097 m³/s | **5.5** |
| joso | 3 405 km² | 238 m³/s | 8 277 m³/s | 73.9 |

Bankfull discharge is the mean annual flood implied by the local climate and the **basin slope**,
and Nagano's window carries 2 000 m of relief. A steep basin gets a large mean annual flood, so the
model gives its river four times Joso's bankfull capacity on twice the catchment — and the storm
then exceeds that capacity by 5.5× rather than 74×. Less water goes overbank, so the stage solves
low. Every step of that is defensible in isolation; the composition is what leaves Nagano short.

## 5. The one finding worth acting on: roughness was calibrated against the wrong reference

Floodplain roughness is the physical lever on solved stage, and round eight set it to 0.10 from
Chow's table after finding the sweep *against the surveyed event extent* had no interior optimum. We
now know that metric is bounded near 25% for any envelope product, so that sweep was run against the
wrong reference. Re-swept against the envelope, all four sites:

| n floodplain | mean IoU | mean POD | mean precision |
|---|---|---|---|
| **0.10 (shipped)** | 48.8% | 58.1% | **73.9%** |
| 0.15 | 50.8% | 61.4% | **73.9%** |
| 0.20 | 52.0% | 63.3% | **74.0%** |
| 0.30 | 53.6% | 65.8% | **74.0%** |

**+7.7 points of hit rate and +4.8 of IoU for precision that does not move at all.** Round eight's
stated worry about a higher roughness was dilution — that the extra extent would be worse than what
was there. Against the right reference there is no dilution to fear: precision is flat to within a
tenth of a point across the whole range.

## 6. Why nothing shipped anyway

The sweep is **still monotone to the edge of the validated range**, which is precisely the condition
round eight used to refuse calibrating on it: *"a sweep with no turning point is a knob, not a
calibration"*. That reasoning did not depend on which reference was used, and it still holds. Taking
0.30 because it scores best would be picking the number that flatters the metric, which is the thing
this line of work has repeatedly caught itself doing and stopped.

So the value must still come from the literature — and the honest literature reading has moved a
little, because these floodplains are built-up and paddy rather than pasture, which Chow's table
puts nearer 0.15 than 0.10. **That is a judgement about a physical constant, not a measurement**, and
it belongs to whoever owns the model rather than to a sweep. It is recorded here with its price
rather than applied.

Nothing about Nagano specifically is fixable this way in any case: roughness at 0.30 buys it 7.3
points of hit rate against the 36 available from a free stage.

## 7. What would actually fix Nagano

- **Drive the comparison at L2 when scoring against an L2 envelope.** The cleanest correction, and
  it is a harness change rather than a model one: score the actual-event run against the surveyed
  extent, and an L2-equivalent run against the envelope. It needs a defensible L2 rainfall per basin,
  which MLIT publishes per river system.
- **Revisit bankfull on high-relief basins.** The basin-slope term is doing something extreme at
  Nagano (987 m³/s of in-bank capacity). Whether that is right is checkable against gauged
  rating curves for the Chikuma, which is a real measurement rather than a sweep.
- **Not a per-site parameter.** Nagano cannot be tuned on its own without fitting four events with
  four knobs, which is how the earlier rounds of this work went wrong.

## 8. Reproducing

```bash
GEO_DATA_MODE=live PORT=9090 GEO_CACHE_TTL_FLOOD_MS=1 DEM_CACHE_DIR=.cache/dem \
  bun run server/index.ts
bun tools/hindcast/storm-sweep.ts nagano                        # §3, §4
bun tools/hindcast/reference.ts gsi10 gsi10-fp15 gsi10-fp20 gsi10-fp30   # §5
```
