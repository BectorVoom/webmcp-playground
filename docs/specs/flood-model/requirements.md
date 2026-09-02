# Requirements — Coupled Pluvial–Fluvial Flood Model API

- **Status:** Implemented
- **Last updated:** 2026-09-02
- **Builds on:** [`docs/specs/inundation-estimate`](../inundation-estimate/requirements.md) — the
  pluvial estimator. This feature adds the river processes that one explicitly excludes, and shares
  its terrain, precipitation and depth-banding machinery.

## 1. Introduction

`POST /api/geo/inundation-estimate` ponds rain where it falls. Validation against the GSI/MLIT L2
inundation map at Fukui showed it captures about a third of the official extent, because the
official map is a *fluvial* product: river flooding driven by an upstream catchment far larger than
any query window, released through levee failure.

This feature adds `POST /api/geo/flood-model`, which represents the coupled surface-water processes
and the mapped infrastructure that materially changes them: **pluvial ponding, river routing,
channel inflow from the upstream catchment, levee breaches, dam storage, storm drainage, and
building storage displacement.**

## 2. Requirements

### R1 — API contract

- **R1.1** Accepts `at {latitude, longitude}` plus optional `radiusKm` (1–20, default 20),
  `rainfallMm` (design storm), `durationHours` (1–72, default 24), `curveNumber` (30–100),
  `channelThresholdKm2` (0.1–1000, default 10), `manningN` (0.01–0.2, default 0.035),
  `channelInflow` (default true), `upstreamRainfallMm` (the catchment's storm, defaulting to the
  town's), `channelDefenceMultiple` (1–100, default 1), `useLevees` (default true), `leveeHeightM`
  (0.5–30, default 5), `demBreachMinDepthM` (0.25–50, default 5),
  `stageDischarge` (`total` | `excess`, default `total`), `volumeConstraint` (default false),
  `arealReduction` (default false), `leveeBreach {enabled, widthM, maxBreaches}`, `useDams`
  (default true), `damAvailableStorageDepthM` (0–20, default 0.5), `useStormSewers` (default true),
  `stormSewerCapacityMmPerHour` (0–200, default 15), `stormSewerServiceRadiusM` (0–2000, default
  100), `useBuildings` (default true), `maximumBuildingBlockedFraction` (0–0.95, default 0.8),
  `dynamicRouting` (default true; false reproduces the former event-average independent-reach
  solve), and `backwater` (default false after failing the four-event hindcast stop rule; requires
  dynamic routing).
  Every out-of-range value is rejected with a 400 naming the field.
- **R1.2** Repeat questions are served from the proxy cache with `x-cache-hit` / `x-cache-age-ms`.
- **R1.3** Upstream failures map through the shared proxy error ladder; an unreadable precipitation
  feed returns 502 and names `rainfallMm` as the offline alternative.
- **R1.4** In fixture mode the whole pipeline runs offline on deterministic synthetic terrain.
- **R1.5** The three formulations that alter the mapped stage — `stageDischarge`,
  `volumeConstraint`, `arealReduction` — default to the behaviour that was last measured against
  the hindcast events, not to the behaviour believed to be more correct. Each default is stated in
  the response under `method`, so a result carries the settings that produced it.

### R2 — Physical processes

- **R2.1 Pluvial.** SCS Curve Number runoff (USDA-NRCS TR-55), as in the pluvial endpoint.
- **R2.2 Network.** D8 flow directions (O'Callaghan & Mark 1984) over the Priority-Flood filled
  surface (Barnes et al. 2014), with flats resolved by pop order so every cell drains to an outlet.
  Contributing area by single-pass accumulation; channels by area threshold.
- **R2.3 Routing.** Event runoff volume is accumulated downstream and converted to an event peak and
  arrival time per reach with an SCS triangular hydrograph. The reach peak, rather than volume
  divided by event duration, is compared against bankfull capacity. Capacity is the catchment's **mean annual flood**,
  derived from ERA5 rainfall climatology (Gumbel 2-year return level → SCS-CN → unit hydrograph),
  with the cross-section from Moody & Troutman (2002); a channel is in equilibrium with roughly its
  two-year flow, so no cross-section is extrapolated and Manning is not in the path. Channels are
  sized by their total catchment, upstream inflow included. Area-keyed hydraulic geometry
  (Bieger et al. 2015) remains a reported fallback when climatology is unavailable.
- **R2.3a Momentum and backwater.** Characteristic speed `u + sqrt(g h)` supplies a hydraulic
  travel-time floor. After the terrain-derived rating curve is solved, a subcritical standard-step
  energy balance propagates downstream controls upstream with Manning friction and velocity head.
  Peaks outside the same event window are not combined; supercritical sections do not pass a
  backwater control upstream. The result remains a maximum-event HAND envelope, not a time-stepped
  two-dimensional Saint-Venant solution. Arrival and characteristic-speed momentum are the default;
  standard-step stage propagation is available as `backwater: true` but does not ship enabled
  because the coarse sections reduce hindcast accuracy.
- **R2.4 Channel inflow.** A coarse regional pass over a wider window finds where rivers cross into
  the query circle and how much land drains to each crossing. Crossings on the same river are
  counted once. Delivered volume is capped by an SCS triangular unit-hydrograph peak over a Kirpich
  (1940) time of concentration, using basin relief for the channel gradient.
- **R2.5 Levee breach.** Over-capacity reaches are breach candidates; outflow is broad-crested weir
  discharge `Q = C·B·h^1.5`, capped at the excess volume actually in the channel, and applied as a
  local loss of channel conveyance.
- **R2.6a Flood defences.** Mapped embankments (OpenStreetMap, via the proxy)
  are rasterised to crest elevations and restrict river inundation to what the
  water can reach; a breach opens a gap the water passes through. Coverage is
  uneven, so the way count and fetch status are reported with every result — an
  absence of mapped defences is reported as missing data, never as their absence.
- **R2.6b Dams.** Mapped dam components are snapped to the drainage network. Event volume is routed
  upstream to downstream and each site retains no more than the mapped permanent-water area whose
  D8 path first reaches it, multiplied by `damAvailableStorageDepthM`; the remainder is passed
  downstream. A dam with no mapped reservoir gets zero invented storage.
- **R2.6c Storm drainage.** Local rainfall runoff within `stormSewerServiceRadiusM` of a mapped
  storm drain, storm/combined sewer, drain or culvert is removed up to
  `stormSewerCapacityMmPerHour × durationHours`. Removal is capped by water present and never
  applied to external river inflow.
- **R2.6d Buildings.** Building footprints are supersampled to a per-cell occupied fraction. That
  fraction displaces sub-grid storage and converts whole-cell depth to open-area depth, capped by
  `maximumBuildingBlockedFraction`; it does not treat a coarse cell as an impermeable wall.
- **R2.6 Conveyance coupling.** A depression may pass water downstream up to the capacity of the
  largest channel through it, and floods only with what the channel cannot carry.
- **R2.7 Conservation.** Volume is conserved exactly: generated rainfall runoff = storm-drain
  capture + surface runoff, and introduced surface water = ponded + drained, asserted in tests,
  with conveyed water passed downstream rather than lost. Dam retention is reported separately in
  the routed river budget and cannot exceed mapped reservoir storage.
- **R2.8 Available volume.** The floodplain storage the mapped stages imply upstream of a point is
  compared against the overbank volume delivered past that point, accumulated along the drainage
  network. The comparison is reported on every request and applied to the stage only when asked
  for: measured against four real events there is roughly twice as much water as the mapped
  surface needs, so it constrains nothing and must not be presented as though it did.
- **R2.8a Asking an upstream once.** The rainfall climatology is a 66-year record for a fixed
  location that does not change within a year, and the archive serving it has a daily request cap
  small enough that a validation run can exhaust it. The fitted series is therefore kept on disk
  between runs and re-asked only when the record grows by a year. What is stored is the
  annual-maximum series, not the derived return level, so a change to the extreme-value fit is
  picked up rather than frozen; a failed fetch is never stored, so an outage cannot pin the model
  to its fallback; and an unreadable or absent store falls through to a fetch, never to an error.
- **R2.9 Areal reduction.** Where the point return level is reduced to a catchment average, the
  factor is Leclerc & Schaake (1972) as used in NWS TP-29, taking storm duration and catchment
  area. It is US-derived and applied globally, like the hydraulic geometry beside it, and is
  declared as such in `limitations`.

### R3 — Honesty about what the model is

- **R3.1** The response carries a `limitations` array naming: event-envelope rather than time-indexed
  output; lumped arrival timing; one-dimensional momentum/backwater without reverse flow, hydraulic
  jumps, bridge contractions or street-scale velocity; stage-based river mapping and its measured
  generosity; inferred rather than surveyed channel geometry; defences and built infrastructure only
  where mapped; simplified dam storage with no operating schedule or failure wave; storm-drain
  capacity with no blockage, surcharge or outfall backwater; sub-grid building storage with no
  wall-resolved flow; bounded regional window; single curve number; pegged stage on very flat ground; no
  storm surge; that `p99DepthMetres` is the figure to quote; and deference to official maps and
  warnings.
- **R3.2** The response reports a pluvial-only baseline and an undefended fluvial baseline from the
  same DEM and storm alongside the result, so a caller can see separately what the river added and
  what the defences removed.
- **R3.3** Network, inflow, defence and breach diagnostics are reported (channel cells, peak
  discharge, arrival/peak hours, characteristic speed, velocity, Froude number, velocity head,
  backwater-affected and stage-capped reaches, overtopping count, reaches defended / stage-pegged / volume-limited, per-inlet
  catchment area, relief, time of concentration, attenuation, embankment ways found and their fetch
  status, each breach's head, discharge and volume, and the available-volume budget — mapped
  storage, the volume delivered past the main stem, the tightest supportable share, and whether it
  was applied), plus dam reservoir area/capacity/retention, storm-drain served area/capture, and
  building footprint/depth multipliers, so a result can be argued with rather than only believed.
- **R3.4** Where a dataset is missing the result says so rather than assuming the world is empty: no
  mapped embankment, dam, drain or building is reported as absent data, never as absent
  infrastructure.
- **R3.5** Where a best-effort input degrades, the degradation is visible in the result and not only
  in its consequences. `climatology.status` distinguishes the ERA5-derived bankfull capacity from
  the area-keyed fallback, which differs from it by an order of magnitude; any comparison between
  two runs is void unless both report `ok`. `climatology.retrievedFrom` says whether the series was
  fetched (`archive`), read back from an earlier fetch (`stored`), or absent (`none`).

### R4 — Output

- **R4.1** Extent is returned as `FloodZone` records with `kind: scenario`, banded on the GSI depth
  legend, vectorised through the existing pipeline and clipped to the query circle.
- **R4.2** Summary statistics and the volume budget (generated rainfall runoff, storm-drain
  capture, surface runoff, channel inflow, ponded, conveyed, drained) are computed within the
  circle; routed dam retention is reported per site.
- **R4.3** Provenance carries `sourceId: estimate.fluvial.coupled`, distinct from the pluvial
  estimator, so the two are never conflated downstream.
