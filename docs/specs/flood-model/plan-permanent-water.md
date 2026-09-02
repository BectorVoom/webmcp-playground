# Plan — Standing water is not flood

- **Status:** Complete. **Shipped as the default** at `maskPermanentWater: true` (§4). Realised gain
  +5.7 points of mean precision against the official envelope, against +6.0 priced in advance. One
  measurement-validity hole found and closed on the way (§5), and a **safety defect found by testing
  outside Japan** and fixed before it could ship anywhere arid (§6).
- **Last updated:** 2026-08-31
- **Inputs:** [`plan-reference-and-dem.md`](./plan-reference-and-dem.md) §8, which diagnosed and
  priced this · [`design.md`](./design.md) §14
- **Scope:** `src/lib/hydrology/water.ts`, `server/water-source.ts`,
  `server/routes/flood-model.ts`, `tools/hindcast/`

## 1. Why

Round ten's §8 found the model reporting Lake Nojiri as two square kilometres of flood, and standing
water as 15–33% of the false-positive area at *every* hindcast site. The model reads terrain and has
no way to tell a lake from low ground, so both of its mechanisms are drawn to one: a lake basin is a
closed depression, so fill-and-spill ponds rain in it and steady state never drains it, and the same
basin carries the drainage network, so the river stage covers it too. That is why 63.4% of the
distant error was wet in *both* fields against 10.7% near the river.

The codebase already knew this in another corner. `src/adapters/geo/glofas-flood.ts` gives permanent
water its own class when reading the European forecast raster, with the note that painting it as
hazard "would report Lake Biwa as an area that is going to flood". The model's own output never got
the same rule.

## 2. What was built

- **`src/lib/hydrology/water.ts`** — `rasteriseWaterBodies` burns mapped water onto the model grid
  by scanline fill, and `maskPermanentWater` drops cells that are wet in both the depth field and
  the water mask. The fill runs in mosaic pixel space, where Web Mercator is linear in longitude and
  monotonic in latitude, so a scanline is a line of constant latitude and the crossing arithmetic is
  exact. Even-odd within a body so an island in a lake is not water; union across bodies so two
  lakes cannot cancel.
- **`server/water-source.ts`** — Overpass, `natural=water` and `landuse=reservoir`, **ways and
  relations**, cached on disk under `WATER_CACHE_DIR` and in memory per box. Best-effort in exactly
  the way the embankments are: an outage degrades to "no known water bodies" and says so in
  `permanentWater.status`.
- **The route** — `maskPermanentWater` (default true), applied to the reported field and to the
  component fields alike so `attribution` describes the answer the caller actually got. Reports
  `permanentWater` beside `defences`, with the area removed and where the mapping came from.

**Only the normal pool is removed.** A cell must already be wet in the water map to be dropped, so
flooding beyond a shoreline survives untouched and this is a floor on the gain rather than a trick.
A new `limitations` entry says so, and says the other half too: a water body left off a flood map
has not become safe.

## 3. Measured

Against the official hazard envelope, on the national DEM, all four events:

| Event | before | after | Δ | geometric ceiling (§7 of round ten) | share of ceiling |
|---|---|---|---|---|---|
| joso | 81.3% | **83.6%** | +2.3 | 87.7% | 95.3% |
| mabi | 69.9% | **74.8%** | +4.9 | 81.6% | 91.7% |
| nagano | 62.2% | **70.3%** | +8.1 | 88.4% | 79.5% |
| kuma | 59.5% | **66.8%** | +7.3 | 70.5% | 94.8% |
| **mean** | **68.2%** | **73.9%** | **+5.7** | | |

And against the surveyed event extent, where the metric is bounded near 25% for any envelope
product (round ten §3):

| Config | IoU | POD | Precision |
|---|---|---|---|
| `baseline-nowater` (round nine/ten default) | 22.1% | 75.5% | 23.8% |
| **`baseline`** (shipped) | **23.9%** | 75.4% | **25.9%** |
| `gsi10-nowater` | 24.4% | 81.6% | 25.3% |
| **`gsi10`** | **26.3%** | 81.4% | **27.4%** |

poly/grid 1.00× throughout.

**Hit rate does not move**: 75.5% → 75.4%, and 81.6% → 81.4%. The extent removed was almost entirely
wrong, which is the whole claim — a mask that was cutting real flooding would show up here first.

The realised +5.7 lands just under the +6.0 priced offline, and every site within 0.6 of prediction.
The small shortfall is the difference between testing lattice points against polygons directly and
rasterising onto a ~31 m grid and vectorising back out.

### Outcome against the acceptance test

Stated before implementing, in the form the previous rounds used:

| Metric | Before | Target | Falsifies | Measured |
|---|---|---|---|---|
| mean precision vs envelope | 68.2% | > 72% | < 70% | **73.9%** ✅ |
| mean POD vs envelope | 58.2% | no material loss | < 56% | **58.1%** ✅ |
| mean precision vs event | 25.3% | ≥ 25.3% | < 25.3% | **27.4%** ✅ |
| poly/grid | 1.00× | 1.00× | any drift | 1.00× ✅ |

## 4. Shipped as the default, and why that is the safe direction

`maskPermanentWater` defaults **true**, like `useLevees`. Three things make that safe rather than a
convenient reading:

- **Failure degrades outward.** An Overpass outage means no mask, which restores the older and more
  generous extent. The unsafe direction here would be a mask that appeared when it should not, and
  that cannot happen from a failed lookup.
- **Nothing is hidden that was ever a warning.** The removed cells are permanently under water. A
  flood map that marks a lake as "will flood" is not telling a reader anything they can act on, and
  the official maps this model is measured against exclude them for the same reason.
- **It is reversible and pinned.** `maskPermanentWater: false` reproduces every figure recorded
  before this round, and the harness keeps `single`, `unsmoothed`, `baseline-nowater` and
  `gsi10-nowater` as pinned configs. All four reproduce their locked values exactly, which is also
  the evidence that the mask is a clean no-op when off.

The honest caveat is coverage, and it is now a stated limitation: where OpenStreetMap maps a channel
wider or narrower than it is, the extent inherits that error, and where it maps nothing the old
behaviour stands.

## 5. The validity hole this opened, and closed

The first measurement said Kuma gained **nothing**, against +7.6 priced. It had gained +7.3; the run
was invalid. Overpass 504'd on Kuma's 20 km box — it was the fourth site in a row to ask — so that
run reported every lake and river channel in the window as flood, and **the harness scored it
anyway**.

The harness already refuses a run whose climatology fell back or whose embankment lookup failed, on
the grounds that it is not comparable with one that did not. Standing water is worth about four
points of precision and degrades the same silent way, and it had no such guard. `assertWaterReal`
now rides the same retry ladder as the embankments; a request that deliberately turns masking off
passes, an outage does not.

This is the third time in this line of work that a silently degraded upstream has produced a
plausible number — the climatology in round seven, the embankments in round eight, standing water
here. The pattern is worth naming: **every best-effort input needs a guard in the harness at the
moment it is added, not after it has cost a measurement pass.**

## 6. Tested outside Japan, where it turned out to be unsafe

Everything above is calibrated on four Japanese events. Six sites in Europe and the United States
were then run to ask whether any of it generalises, chosen for the two ways this feature could fail
on unfamiliar ground: arid catchments, and lake-dominated ones.

**It found a safety defect that Japan could not have exposed.** OpenStreetMap marks a seasonally dry
water body `intermittent=yes`. Around Tucson **47.8% of mapped water bodies carry that tag** (189 of
395 in the query box), against 3–10% at every temperate site surveyed and 5.6% at Joso. An
intermittent body is dry most of the time — it *is* land that floods, and in an arid catchment the
ephemeral wash is the flash-flood hazard rather than an exception to it. The mask was deleting them.

| Tucson, same request | mask bodies | reported extent |
|---|---|---|
| before the fix | 673w + 21r | 64.3 km² |
| **after the fix** | 288w + 15r | **76.4 km²** |
| no mask at all | — | 76.7 km² |

**The fix restored 12.1 km² — 16% of the extent — of flash-flood hazard the mask had been erasing.**
`intermittent=yes` and `seasonal=yes` are now excluded in the Overpass query and again on parse, and
the on-disk store carries a `STORE_VERSION` so payloads gathered under the old query are ignored
rather than trusted (the store holds parsed geometry, so a query-level filter can never apply
retroactively to it). Japan is unaffected: all six pinned configurations reproduce their locked
figures exactly.

**How much the mask matters is enormously regional.** With the fix in place, and every run reporting
`climatology: ok` and `permanentWater: ok`:

| Site | storm | unmasked | masked | removed | share |
|---|---|---|---|---|---|
| Tampere, FI (lakes) | 100 mm / 24 h | 296.8 | **68.0** | 228.8 | **77.1%** |
| Ahrweiler, DE (Ahr 2021) | 150 mm / 24 h | 75.7 | 60.2 | 15.5 | 20.5% |
| Cedar Rapids, US | 200 mm / 48 h | 137.4 | 117.7 | 19.7 | 14.4% |
| Houston, US (Harvey) | 500 mm / 48 h | 554.5 | 541.4 | 13.1 | 2.4% |
| Valencia, ES (DANA) | 300 mm / 8 h | 153.6 | 151.8 | 1.8 | 1.2% |
| Tucson, US (arid) | 60 mm / 6 h | 76.7 | 76.4 | 0.3 | 0.4% |

From 0.4% to 77%. In the Finnish lake district three quarters of what the model called flood was
lakes; in the Arizona desert almost nothing is maskable once intermittent water is excluded, which
is the correct answer in both cases. Japan sat in the middle, which is why neither extreme showed up
in calibration.

**Neither region can be scored the way Japan was**, and that is a limit on the whole accuracy record
rather than on this round:

- **Europe has no open flood-hazard envelope.** `src/adapters/geo/eu/flood.ts` already documents it:
  Copernicus EFAS is behind CEMS authentication and the Floods Directive maps are held nationally in
  27 formats. There is no endpoint to score against.
- **FEMA's NFHL is open but was unreachable** from this environment — every request to
  `hazards.fema.gov` failed to connect while Overpass answered normally, which is the same
  limitation already recorded in `src/adapters/geo/us/flood.ts`.

So the EU and US work here is a behaviour and safety test, not an accuracy measurement. **Every
precision figure in this directory remains Japan-only**, and the model's accuracy outside Japan is
untested rather than assumed comparable.

## 7. What this does not answer

- **Accuracy outside Japan is unmeasured**, for want of a reachable reference (§6). The six EU/US
  runs show the model behaves and degrades correctly there; they say nothing about whether it is
  right.
- **A reservoir's flood pool is not its normal pool.** Only the mapped normal pool is masked, so a
  reservoir that rises beyond its shoreline is still reported — but the mapped outline is the summer
  pool at whatever level the imagery caught, and that is not a defined datum.
- **Nagano still trails** at 79.5% of its geometric ceiling against 92–95% elsewhere, which is the
  smallest gap it has ever had but still the largest of the four.
- **The river channel is masked along with the lakes.** That is right for scoring against an
  envelope and right for "this is already water", but a reader who wants the channel drawn has no
  option to keep it; a separate class rather than a removal would serve both.

## 8. Reproducing

```bash
GEO_DATA_MODE=live PORT=9090 GEO_CACHE_TTL_FLOOD_MS=1 DEM_CACHE_DIR=.cache/dem \
  bun run server/index.ts
bun tools/hindcast/run.ts fetch
bun tools/hindcast/warm-dem.ts gsi10
bun tools/hindcast/run.ts score single unsmoothed baseline-nowater baseline gsi10-nowater gsi10
bun tools/hindcast/reference.ts gsi10-nowater gsi10        # §3
```
