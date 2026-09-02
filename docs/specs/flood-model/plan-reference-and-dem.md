# Plan — The reference the model is judged against, and the DEM it is built on

- **Status:** Complete. Both questions measured. The reference question is **settled by a control**
  (§3); the DEM question is measured, real, and **smaller than the reference effect by a factor of
  thirty** (§4). §7 then answers the spread §5 left open — of the two trailing sites, only Nagano
  actually trails — and §8 diagnoses the last unexplained error as the model reporting lakes as
  flood, priced at +6.0 points of mean precision and **since fixed and shipped** in
  [`plan-permanent-water.md`](./plan-permanent-water.md), which realised +5.7. Four defects found
  and fixed on the way (§6, §7, §8).
- **Last updated:** 2026-08-31
- **Inputs:** [`plan-precision-profile.md`](./plan-precision-profile.md) (round eight) ·
  [`plan-stage-smoothing.md`](./plan-stage-smoothing.md) (round nine) · [`design.md`](./design.md) §12
- **Scope:** `tools/hindcast/`, `server/flood-inputs.ts`, `server/routes/flood-model.ts`,
  `src/lib/hydrology/terrain.ts`

## 1. Why

Round nine spent the last of the measured stage-allocation headroom and left mean precision at
23.8% against a stated target of 80%. Round eight had already bounded the method: sweeping the one
remaining free field with hindsight never exceeded 34.3% precision at any site, best mean 25.0%.
Two candidate explanations survived that, and they call for opposite work:

- **The DEM is the constraint.** 60–75 m SRTM-derived terrain with metres of vertical error, over
  floodplains with metres of total relief. `design.md` §12 names this the binding constraint and
  nominates a finer DEM as the fix.
- **The reference is the constraint.** Every figure ever published here scores an *envelope* — the
  ground a design storm can reach — against **one event's surveyed extent**, which is the water one
  particular levee failure happened to put on the ground on one day. The model does not predict
  that and never claimed to.

Both are now measured, on the same four events and the same lattice points.

## 2. The two experiments

**The reference** (`tools/hindcast/reference.ts`, `hazard.ts`). MLIT's 洪水浸水想定区域 — the
official flood inundation assumption zone at the L2 "maximum assumed scale" storm — read from GSI's
disaster portal as raster tiles at zoom 13 (~15 m/px, six times finer than the 100 m scoring
lattice). It is sampled at **exactly the lattice points the model is already scored on**, so the
window, the padding and the circle clip are all unchanged and only the truth moves.

**The DEM** (`demSource` on the route). Three arms, chosen to separate the two different things a
better DEM changes — conflating them is how "we need better data" stays an opinion:

| Arm | Tileset | Cell | What it isolates |
|---|---|---|---|
| `baseline` | terrarium z11 | ~62 m | the shipped default |
| `demz12` | terrarium z12 | ~31 m | **grid resolution alone** — same SRTM information |
| `gsi10` | GSI DEM10B z12 | ~31 m | **terrain information** — Japan's national 10 m survey |

Both fine arms land at z12 because the 20 km circle's grid budget degrades anything finer, so they
are compared on *identical* geometry rather than merely similar. The wider context window that
supplies upstream inflow stays on the global source in every arm, so the water arriving at the
scored window is the same in all three.

## 3. The reference: settled by a control, not by argument

The claim "we are being scored against the wrong thing" is self-serving, so it was tested the only
way that can settle it — **score the official hazard map as if it were a prediction of the one
event**, on the same points, with the same metric. It depends on no setting of ours.

| Event | IoU | POD | Precision |
|---|---|---|---|
| joso | 27.4% | 98.6% | 27.5% |
| mabi | 32.0% | 99.3% | 32.1% |
| nagano | 10.8% | 99.7% | 10.8% |
| kuma | 30.4% | 98.3% | 30.5% |
| **mean** | **25.1%** | **99.0%** | **25.2%** |

**Japan's official, authoritative, professionally produced flood map scores 25.2% precision against
these event surveys.** Our shipped model scores 23.8%, and with the national DEM, 25.3% — *above*
the official product on the same metric.

Its POD of 99.0% is the tell: the official envelope contains essentially all the water that
actually flooded. It is not inaccurate. It is an envelope being charged for the ground this
particular flood did not happen to occupy.

**An 80% precision target defined against a single event's surveyed extent is unreachable by any
envelope product, including the official one.** That is not a limitation of this model, and no
amount of modelling work addresses it.

### Scored against the envelope instead

Same model extent, same points, official envelope as truth:

| Config | Prec vs event | **Prec vs envelope** | IoU vs envelope | POD vs envelope |
|---|---|---|---|---|
| baseline | 23.8% | **67.1%** | 43.3% | 54.0% |
| demz12 | 24.0% | 66.4% | 46.0% | 58.9% |
| gsi10 | 25.3% | **68.2%** | 46.7% | 58.2% |

Per site, at `gsi10`: **Joso 81.3%**, Mabi 69.9%, Kuma 59.5%, Nagano 62.2%.

And the direct statement of what the old metric was counting as error — of the model extent the
event survey scores as a false positive, the share that sits inside officially designated
flood-prone ground:

| Event | FP km² vs event | inside the official envelope | share |
|---|---|---|---|
| joso | 87.8 | 63.4 | 72.2% |
| mabi | 16.1 | 8.8 | 54.5% |
| nagano | 97.8 | 57.6 | 58.9% |
| kuma | 8.7 | 3.6 | 41.3% |
| **mean** | | | **56.7%** |

**Over half of the model's "wrong" water is ground the responsible authority has itself designated
as floodable.**

## 4. The DEM: real, measured, and much smaller

Against the event survey, mean precision:

| Arm | mean IoU | mean POD | mean precision | joso / mabi / nagano / kuma precision |
|---|---|---|---|---|
| baseline (62 m SRTM) | 22.1% | 75.5% | 23.8% | 24.5 / 28.8 / 11.8 / 30.3 |
| demz12 (31 m SRTM) | 22.7% | 84.0% | 24.0% | 22.5 / 31.9 / 12.6 / 28.8 |
| **gsi10 (31 m national)** | **24.4%** | 81.6% | **25.3%** | 26.2 / 34.2 / 9.2 / 31.8 |

poly/grid 1.00× in all twelve runs.

**Resolution alone buys 0.2 points of precision. The terrain information buys 1.3.** Halving the
cell size while keeping the same SRTM behind it moves precision by noise, exactly as it should —
upsampling adds no information. Swapping in a real national survey at *identical* cell size is what
moves the score, and it improves three sites of four.

This is a real effect and it points the right way, but it must be read against §3: **the DEM is
worth about 1.5 points of precision; the reference is worth 43.** A finer DEM was the leading
candidate for the remaining gap and it is not close to sufficient.

Nagano goes the wrong way (11.8% → 9.2%) and remains the site every round has flagged as
reference-limited; its observed extent spans the whole Chikuma corridor, and 30 of its 84 hazard
tiles carry no designated zone at all, so both of its references are weaker there than elsewhere.

### The depth floor does not help against an envelope

Free to compute, and the natural next thought, so it was measured rather than assumed:

| Keep | baseline prec vs envelope | gsi10 prec vs envelope |
|---|---|---|
| >= 0.05 m (as shipped) | **67.1%** | **68.2%** |
| >= 0.50 m | 67.3% | 68.1% |
| >= 3.00 m | 64.8% | 62.0% |
| >= 5.00 m | 59.9% | 56.7% |

Flat, then falling. Under the event reference a depth floor bought a little precision by discarding
hit rate; against an envelope it buys nothing at all. **The full reported extent is already the best
operating point**, which is the convenient answer but is also the measured one.

## 5. Outcome

| Metric | Round nine | This round | Target |
|---|---|---|---|
| mean precision vs event | 23.8% | 25.3% (`gsi10`) | — bounded at ~25% by §3's control |
| **mean precision vs envelope** | (never measured) | **68.2%** | 80% |
| best site vs envelope | — | **81.3%** (Joso) | ✅ clears 80% |
| mean IoU vs envelope | — | 46.7% | — |
| poly/grid | 1.00× | 1.00× | ✅ |

**Neither change ships as a default.** `terrarium` stays the default DEM because it is the only
tileset with worldwide coverage and this is not a Japan-only product; `gsi10`/`gsi5` are opt-in via
`demSource` and are the right choice for any Japanese query. The reference work changes no model
behaviour at all — it changes what the numbers in this directory mean.

## 6. Two defects found while measuring

**Voids over water silently returned an empty model.** GSI's elevation sets carry no value over
open water — 7.0% of the 20 km circle at Hitoyoshi, 5.7% at Mabi, tens of thousands of contiguous
cells. The first `fillElevationVoids` relaxed voids inward one ring per sweep under a fixed pass
budget, which repaired a scattering of pixels and gave up silently on a sea: 56 491 cells stayed
NaN at Kuma, NaN compares false against everything, and the route returned **0.004 km² of flooding
with no error at all**. It is now a two-pass chamfer that fills every void with the nearest measured
elevation in O(cells) regardless of void size — which is also the right answer at a coastline, since
the nearest measured ground to a sea void is the shore (0 to −3 m at these sites), leaving the sea a
flat shelf water can drain across rather than the wall an inland interpolation would build. Covered
by tests, including one void far wider than any fixed pass budget.

**A national data source that a global one never exercises.** `cyberjapandata.gsi.go.jp` is fronted
by CloudFront and publishes AAAA records. On a host with no working IPv6 route, Bun's `fetch` picks
the AAAA address and blocks until timeout — it has no Happy Eyeballs fallback — while `curl` fetches
the same URL in 120 ms. The global terrarium host is IPv4-only, which is why the model had never met
this. The server keeps using `fetch`, which is correct anywhere IPv6 works or DNS is IPv4-only;
`tools/hindcast/warm-dem.ts` fills the on-disk tile store with `curl` so a scored run touches no GSI
endpoint. Elevation tiles are now kept under `DEM_CACHE_DIR` regardless of source — the ground does
not move between requests, so a tile is worth fetching once per machine.

## 7. Why Kuma and Nagano trail Joso — one of them does not

§5 read 81.3 / 69.9 / 62.2 / 59.5 as four sites the model handles differently well. That reading
assumes precision is comparable across the four windows. **It is not**, and once the comparison is
made properly only one of the two trailing sites is actually trailing.
(`tools/hindcast/envelope-gap.ts`.)

### The spread is mostly base rate

Precision depends on how much of the scored window is wet to begin with — a predictor firing at
random scores exactly the prevalence. The four windows are not remotely alike:

| Event | window km² | envelope share (what a coin scores) | precision | informedness | MCC |
|---|---|---|---|---|---|
| joso | 225.8 | 54.8% | 81.3% | 0.617 | 0.622 |
| mabi | 95.9 | 29.1% | 69.9% | 0.480 | 0.509 |
| nagano | 994.2 | 18.0% | 62.2% | 0.336 | 0.409 |
| kuma | 108.6 | 14.1% | 59.5% | 0.446 | 0.480 |

**The null-model spread is 40.7 points; the observed precision spread is 21.8.** The base rate
alone more than accounts for the ranking — the model is compressing that spread, not creating it.
Prevalence-robust skill reorders the bottom two: by MCC it is joso > mabi > **kuma** > nagano.

Lift (precision ÷ prevalence) inverts the ranking outright — kuma 4.23×, joso 1.48× — but it is
reported here only to show the direction, **not** as the verdict: lift is itself bounded by
1/prevalence, so normalising by that bound returns precision and the argument goes in a circle. MCC
and informedness are the honest prevalence-free numbers.

### What a perfect answer could score

The decisive measurement takes the envelope itself — a flawless answer — displaces it by one and two
lattice cells, and scores it against the truth it came from. That is the precision ceiling for a
model with the shape exactly right and the position off by 100 m, and it depends only on the
target's geometry:

| Event | perfect | off by 100 m | off by 200 m | ours | **share of the 100 m ceiling** |
|---|---|---|---|---|---|
| joso | 100% | 87.7% | 81.1% | 81.3% | **92.6%** |
| mabi | 100% | 81.6% | 71.0% | 69.9% | **85.6%** |
| nagano | 100% | 88.4% | 83.7% | 62.2% | **70.4%** |
| kuma | 100% | **70.5%** | 56.9% | 59.5% | **84.5%** |

**Kuma's target is narrow.** Its envelope averages 167 m from centre to edge against Joso's 425 m —
between three and four 100 m lattice cells wide, total. A *perfect* answer misregistered by a single
cell scores 70.5% there, and our 59.5% is 84.5% of that, ahead of the 200 m ceiling of 56.9%. Its
errors hug the boundary harder than any other site's (58.9% within 100 m). Kuma is not a site the
model is worse at; it is a site where being nearly right is worth less.

**Nagano genuinely trails**, at 70.4% of its ceiling against 84–93% everywhere else, and geometry
does not excuse it: its ceiling (88.4%) is the most forgiving of the four. Two separable causes,
both real:

- **A third of its window is ground the reference has no opinion on.** 34.3% of Nagano's lattice
  falls on tiles the portal does not serve — no river's assumption area reaches there. Scoring only
  where the envelope is authoritative lifts it 62.2% → 65.7%. The other three sites are 0.0%
  undesignated and do not move at all.
- **It has real distant error.** 8.0% of its false positives lie more than 3 km from the envelope,
  four times any other site (joso 0.2%, mabi 0.0%, kuma 0.0%). That is not a registration error or
  a fringe; it is water in the wrong place.

**A defect in round ten's own method, found by this.** `hazard.ts` counted an undesignated tile as
*dry*. That is precisely the error this harness was built to avoid — its README has always insisted
that land GSI never surveyed is "not mapped, never known dry" — and the envelope deserved the same
rule. `HazardMask` now carries `designated`, and every figure above is reported both ways. It
changes nothing at three sites and 3.4 points at the fourth, which is why it had to be checked
rather than assumed.

## 8. What Nagano's distant water is: the model floods lakes

§7 left one thing genuinely unexplained — 8.0% of Nagano's false-positive area more than 3 km from
any designated zone, against 0.0–0.2% everywhere else. It is diagnosed, and it is not a Nagano
defect. (`tools/hindcast/distant-fp.ts`.)

| Cut | distant FP (>3 km) | near FP (≤3 km) | true positives |
|---|---|---|---|
| on undesignated ground | **88.1%** | 7.4% | — |
| pluvial involved | **78.0%** | 12.4% | 16.5% |
| elevation p50 | **657 m** | 342 m | 340 m |
| distance to the surveyed extent, p50 | **11.3 km** | 0.9 km | 0.9 km |

The distant water sits three hundred metres *above* the Chikuma floodplain, is put there by rain
ponding rather than river stage, and stands on ground no river's assumption area reaches. It is also
not scattered: 68 blobs, of which the largest alone is 2.09 km² — 61% of the distant area — centred
at 36.8301, 138.2267 on ground the DEM reads at 657 m.

**That is Lake Nojiri** (野尻湖, OSM relation 2314067, surface 654 m). Blobs 3 and 4 are a dam and its
reservoir west of the city. Asking OpenStreetMap directly, **68.5% of the distant false-positive
area falls inside a mapped lake or reservoir**, against 29.6% of the near ones.

The mechanism follows from what a lake is. A lake basin is a closed depression, so fill-and-spill
ponds rain in it and steady state never drains it; it also carries the drainage network, so the
fluvial stage covers it too. Hence the 63.4% of distant cells wet in *both* fields, against 10.7%
near the river. The model has **no concept of permanent water**, and an official flood map
necessarily does: a lake is not land that floods.

### It is systematic, and it is the cheapest fix left

Only Nagano's window contains a large upland lake, which is why only Nagano shows it *at distance* —
but every site pays for it next to the river:

| Event | FP that is standing water | precision | masking permanent water | Δ |
|---|---|---|---|---|
| joso | 3.7 of 24.4 km² (15.0%) | 81.3% | **83.6%** | +2.3 |
| mabi | 1.6 of 7.0 km² (23.4%) | 69.9% | **75.2%** | +5.3 |
| nagano | 13.8 of 42.1 km² (32.7%) | 62.2% | **71.0%** | +8.7 |
| kuma | 1.5 of 5.2 km² (28.2%) | 59.5% | **67.1%** | +7.6 |
| **mean** | | **68.2%** | **74.2%** | **+6.0** |

Masking only the *normal pool* — cells the model calls wet that are already permanently wet — so any
genuine flooding beyond a shoreline is untouched and this is a floor on the gain rather than a
trick. **+6.0 points of mean precision, four times what the national DEM bought (§4)**, and it moves
Nagano's share of its geometric ceiling from 70.4% to 80.3%. Ranked by that share the four sites then
sit at 95.3 / 92.2 / 95.2 / 80.3%.

**Implemented and shipped in round eleven** — see
[`plan-permanent-water.md`](./plan-permanent-water.md). The realised gain was +5.7 points of mean
precision against the +6.0 priced here, at unchanged hit rate, and every site landed within 0.6 of
the estimate above.

**A third defect, in this investigation's own method.** The first water query asked Overpass for
`way`s only, and every lake worth the name is a multipolygon *relation* — so it missed Lake Nojiri
entirely and reported the distant water as 3.0% lake, which would have buried the finding. Relations
are now fetched and their outer members stitched into rings before use. A reference that silently
omits the largest feature in the window is the same class of error as §7's undesignated ground, found
the same way: by checking a number that looked wrong against the map rather than accepting it.

## 9. What this does not answer

- **68.2% is not 80%**, and §7 says only Nagano has a diagnosable deficit left. Kuma sits at 84.5%
  of what its geometry permits, so the mean is held down partly by targets that are narrow rather
  than by a model that is wrong; a mean precision taken across sites of such different prevalence is
  a weak summary statistic and should probably be retired in favour of the ceiling-normalised share.
- **Nagano's distant error is explained (§8) and fixed** in round eleven, which took the mean to
  73.9% and Nagano to 79.5% of its geometric ceiling. It is still the weakest of the four.
- **Whether masking water is right at a reservoir** is not settled here. A reservoir's normal pool is
  permanently wet, but its flood pool is not, and this prices only the former.
- **The envelope is a reference, not truth.** It is itself modelled, drawn per river system by the
  managing authority, and designated only where a river has been designated — 30 of Nagano's 84
  tiles carry no zone. Scoring against it rewards agreeing with another model.
- **`gsi5` is implemented but unmeasured.** At 20 km the grid budget degrades it to the same z12 as
  `gsi10`, so the 5 m LiDAR is only reachable by shrinking the query window, which changes the
  hydrology as well as the resolution and so needs its own matched-radius control.
## 10. Reproducing

```bash
GEO_DATA_MODE=live PORT=9090 GEO_CACHE_TTL_FLOOD_MS=1 DEM_CACHE_DIR=.cache/dem \
  bun run server/index.ts
bun tools/hindcast/run.ts fetch
bun tools/hindcast/warm-dem.ts gsi10                       # once per machine
bun tools/hindcast/run.ts score baseline demz12 gsi10      # §4
bun tools/hindcast/reference.ts baseline demz12 gsi10      # §3, §4's depth floor
bun tools/hindcast/envelope-gap.ts gsi10 baseline          # §7
bun tools/hindcast/distant-fp.ts nagano gsi10             # §8
```

The ERA5 climatology and the mapped embankments for all four sites are already on disk; nothing
above touches either archive. See [`tools/hindcast/README.md`](../../../tools/hindcast/README.md)
for what invalidates a run.
