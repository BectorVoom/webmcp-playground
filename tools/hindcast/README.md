# Hindcast harness

Scores `/api/geo/flood-model` against GSI's surveyed inundation for four
Japanese flood disasters. Every accuracy figure in
[`docs/specs/flood-model/`](../../docs/specs/flood-model/) comes from here.

This lived outside the repository for four rounds of accuracy work and was
rebuilt from scratch three times. It is committed now because the fourth rebuild
was the thing standing between a question and its answer.

## Running it

```bash
GEO_DATA_MODE=live PORT=9090 GEO_CACHE_TTL_FLOOD_MS=1 DEM_CACHE_DIR=.cache/dem \
  bun run server/index.ts

bun tools/hindcast/run.ts fetch      # observed extents, downloaded and verified
bun tools/hindcast/run.ts score single unsmoothed baseline-nowater baseline  # locked baselines
bun tools/hindcast/run.ts score fp060 fp100 fp200   # sweep floodplain roughness
bun tools/hindcast/run.ts score sm025 sm05 sm1 sm2  # sweep stage smoothing window
HINDCAST_EVENTS=joso,mabi,nagano,kuma \
  bun tools/hindcast/run.ts score hydraulic-steady hydraulic-timing hydraulic-dynamic  # dynamics A/B
bun tools/hindcast/warm-dem.ts gsi10 # fill the DEM store (once per machine)
bun tools/hindcast/run.ts score baseline demz12 gsi10   # the DEM arms
bun tools/hindcast/reference.ts baseline gsi10  # event survey vs official envelope
bun tools/hindcast/envelope-gap.ts gsi10        # why a site's precision differs
bun tools/hindcast/distant-fp.ts nagano gsi10   # what the wrong water actually is
bun tools/hindcast/storm-sweep.ts nagano        # is the gap the storm, the stage, or the site?
bun tools/hindcast/profile.ts        # where the over-prediction is
bun tools/hindcast/counterfactual.ts # would filtering the extent help?
bun tools/hindcast/ceiling.ts        # best extent HAND on this DEM can give
bun tools/hindcast/roughness-attribution.ts     # which field a change acted on
bun tools/hindcast/breach-check.ts   # predicted failures vs the surveyed one
```

## Which reference a score is against

`run.ts`, `profile.ts` and everything older score against **one event's surveyed extent**. That is
one realisation of a flood, and the model produces an envelope, so the two are not the same kind of
object: round ten measured the official 洪水浸水想定区域 against these same surveys and it scores
25.2% precision — no better than this model does. Precision against a single event is bounded near
25% for *any* envelope, so treat it as a regression tripwire, not as a quality target.

`reference.ts` scores the same extent, on the same lattice points, against that official envelope
as well, and reports both side by side. See
[`plan-reference-and-dem.md`](../../docs/specs/flood-model/plan-reference-and-dem.md) §3.

**Precision is not comparable between sites**, under either reference. It depends on how much of the
window is wet to begin with, and these windows run from 14% to 55% envelope — a 41-point spread
before any model runs. Kuma's envelope is also narrow enough (167 m mean half-width, against Joso's
425 m) that a *perfect* answer misregistered by one 100 m lattice cell scores only 70.5% there
against Joso's 87.7%. `envelope-gap.ts` reports prevalence, MCC, informedness and that
per-site ceiling, and the share-of-ceiling column is the only cross-site comparison of the four that
is entitled to be made.

## What it does

Scoring is a 100 m lattice over the surveyed footprint padded by 2 km and
clipped to the query circle. A point is a hit where it falls inside both an
observed polygon and a returned zone. Land the survey never covered is **not
mapped**, never *known dry* — which is why the lattice never leaves the surveyed
footprint, and why POD, precision and IoU are the metrics rather than accuracy.

## Three things that will invalidate a run

- **A climatology fallback.** When the ERA5 archive call fails the route falls
  back to area-keyed hydraulic geometry, which moves scored extent ~2% and IoU
  ~0.3 points. Refused, not scored.
- **A standing-water outage.** The same Overpass, the same silent degradation:
  a run whose water lookup failed reports every lake in the window as flood,
  which is worth about four points of precision. Retried with backoff, then
  refused. It cost this work one measurement pass before the check existed.
- **An embankment outage.** Overpass answers a 20 km box with megabytes and
  returns 504 or 429 under load; the route then reports the floodplain as
  undefended, which is 18.5 km² at Joso. Retried with backoff, then refused.
  Since round eight a good answer is kept under `LEVEE_CACHE_DIR`, so this costs
  you once per site rather than once per server restart — but the first fetch
  still has to get through, and Overpass can take a while to let it.
- **Polygon/grid drift.** `poly/grid` must stay 1.00×. A change that dilates the
  extent raises POD for free, and coarsened vectorisation has faked a 12-point
  gain here before.

## Caches

- `.cache/hindcast/zips`, `raw` — the observed extents. Archives are checked
  byte for byte against the sizes recorded in `events.ts`, and the parsed area
  against the km² in the specs, so a reissued file fails loudly rather than
  quietly restating every score.
- `.cache/hindcast/runs` — model responses, keyed by request. Analysis is
  iterated far more often than the model changes. **Delete it after changing the
  model**; nothing here can tell that the code moved. `HINDCAST_REFRESH=1`
  bypasses it.
- `.cache/osm-water` — mapped lakes and reservoirs the *route* excludes from the
  extent, keyed by query box, exactly as the embankments are.
- `.cache/hindcast/water` — the harness's own copy, per event, for the
  standing-water cut in `distant-fp.ts`. Overpass answers a 20 km box with a
  megabyte and 504s while it decides whether to, so the query retries with
  backoff; **relations as well as ways**, because every lake worth the name is a
  multipolygon and a way-only query silently omits the largest one in the window.
- `.cache/hindcast/hazard` — the official hazard-map raster, keyed by tile. A
  `.404` marker means the portal has no designated zone there, which is a real
  answer and is stored so it is not re-asked.
- `.cache/dem` — elevation tiles, by source. The ground does not move between
  requests, so a tile is worth fetching once per machine. **GSI tiles must be
  warmed with `warm-dem.ts` on a host without working IPv6**: their CDN
  publishes AAAA records and Bun's `fetch` has no Happy Eyeballs fallback, so it
  blocks until timeout where `curl` succeeds in 120 ms. The global terrarium
  host is IPv4-only and never shows this.
- `.cache/era5` — the rainfall climatology, and the scarcest resource in the
  repository. The harness warms each site once and works from disk after that.
- `.cache/osm-levees` — mapped embankments, for the same reason. Overpass is a
  free community service that asks not to be hammered.

## Regional scope

Most figures here are Japanese, but **Europe is no longer unmeasured**. England's Environment
Agency publishes *Recorded Flood Outlines* — 31 696 surveyed extents, open, over WFS — and
`bun tools/hindcast/eu.ts` scores two English events against them. Results and their caveats are in
[`design.md` §16](../../docs/specs/flood-model/design.md).

Two limits remain, and neither is cosmetic:

- **"Europe" here means England.** Both events are English because the EA service is the open,
  machine-readable one. Copernicus EMS Rapid Mapping covers continental events but publishes
  shapefile packages through a JavaScript portal, which nothing here reads. A continental site
  would be the single most valuable addition to this harness.
- **The storm forcing is weaker evidence than Japan's.** The Japanese events are driven with totals
  from official post-event reports; the English ones with ERA5, which under-catches orographic rain
  badly. That is why `eu.ts` sweeps rainfall instead of reporting one score, and why its headline
  row is the one whose *area* matches the survey.

The US is still unmeasured: FEMA's NFHL is open but was unreachable from this environment.

## The events

| Event | Storm | Observed | Query |
|---|---|---|---|
| 2015 Kinugawa, Joso | 490 mm / 48 h | 35.8 km² | observed-bbox centroid, 20 km |
| 2018 Oda R., Mabi | 342 mm / 72 h | 8.9 km² | as above |
| 2019 Chikuma, Nagano | 196.8 mm / 48 h | 20.1 km² | as above |
| 2020 Kuma R., Hitoyoshi | 322 mm / 12 h | 4.8 km² | as above |
| 2015 R. Eden, Carlisle | 61.9 mm / 72 h † | 14.8 km² | as above |
| 2007 Severn/Avon, Tewkesbury | 84.6 mm / 48 h † | 51.7 km² | as above |

† ERA5 at the query centre, not an official post-event total — see the storm caveat above. Run
these two with `bun tools/hindcast/eu.ts`, which sweeps the rainfall rather than trusting it.

Fukui 2004 has no machine-readable observed extent and so contributes to no
metric here.
