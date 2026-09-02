# Requirements — Inundation Depth & Extent Estimation API

- **Status:** Implemented
- **Last updated:** 2026-08-30
- **Builds on:** [`docs/specs/disaster-safety`](../disaster-safety/requirements.md) — this is a
  server-computed estimator that speaks that feature's hazard vocabulary (`FloodZone`, `DepthBand`,
  `Provenance`), not a new application.

## 1. Introduction

The disaster-safety providers report what an authority has *published* about flooding. This feature
answers a different question: given the rain that is forecast (or a design storm), **how deep and
how widespread would ponding be around this point**, estimated from first principles — precipitation
plus terrain — within a radius of up to 20 km. It exists for places and events the published maps do
not cover, and it is a *screening* estimate, always delivered with its limitations attached.

The estimate is computed on the server (`POST /api/geo/inundation-estimate`): the DEM decode and the
hydraulic spread are too heavy for per-client recomputation, and server computation makes the result
cacheable per (location, storm) question.

## 2. Requirements

### R1 — API contract

- **R1.1** The endpoint accepts `at {latitude, longitude}` (required) and optional `radiusKm`
  (1–20, default 20), `rainfallMm` (0–2000 design storm), `durationHours` (1–72, default 24) and
  `curveNumber` (30–100, default 80). Every out-of-range value is rejected with a 400 naming the
  field.
- **R1.2** Repeat questions are served from the proxy cache (flood TTL) with the standard
  `x-cache-hit` / `x-cache-age-ms` headers.
- **R1.3** Upstream failures map through the shared proxy error ladder (`HostNotAllowed`,
  `SourceCircuitOpen`, `UpstreamTooLarge`, `UpstreamFailed`); an unreadable precipitation feed tells
  the caller that `rainfallMm` is the offline alternative.
- **R1.4** In fixture mode the pipeline runs end-to-end on deterministic synthetic terrain with no
  network access, and the result is labelled `mode: fixture`.

### R2 — Scientific method

- **R2.1** Rainfall→runoff uses the SCS Curve Number method (USDA-NRCS TR-55): S = 25400/CN − 254,
  Ia = 0.2·S, Q = (P−Ia)²/(P−Ia+S).
- **R2.2** Runoff volume is distributed over the DEM by Priority-Flood depression analysis
  (Barnes et al. 2014) with level-pool fill-and-spill routing: each depression receives the runoff
  of its own drainage area, stores it up to capacity with a flat surface, and passes the excess to
  the next depression downstream or out of the domain.
- **R2.3** Volume is conserved exactly: generated = ponded + drained, asserted in tests.
- **R2.4** Cell areas use per-row ground geometry (inverse Mercator), not a single constant, so the
  volume bookkeeping is correct across the latitude span of the mosaic.
- **R2.5** The model has no time axis and no channel conveyance, and says so: the response carries a
  `limitations` array naming pluvial-only scope, the uniform curve number, absent urban drainage,
  DEM resolution, uniform rainfall, and deference to official maps and warnings.

### R3 — Data inputs

- **R3.1** Terrain comes from Terrarium-encoded Mapzen/AWS Terrain Tiles at z11 (~60–75 m cells),
  fetched through the geo proxy (allowlist, circuit breaker, byte caps) and decoded server-side.
- **R3.2** Precipitation comes from Open-Meteo hourly forecast accumulated over `durationHours`,
  sampled at five points across the circle and averaged — unless the caller supplies a `rainfallMm`
  design storm, which takes precedence and requires no network.
- **R3.3** The DEM is conditioned before use: void pixels implausibly far below their neighbourhood
  are despiked (second-lowest-neighbour rule, border cells exempt), and open water — cells at or
  below 0 m connected to the domain edge — is masked as an outlet, never reported as flooded.
- **R3.4** The DEM grid is bounded (≤ 64 tiles); a larger request degrades zoom rather than
  exceeding the budget, and the radius is honoured before the resolution.

### R4 — Output

- **R4.1** Depth extent is reported as `FloodZone` records with `kind: scenario` (the design event
  names the storm and curve number), banded on the GSI depth legend (<0.5 / 0.5–3 / 3–5 / ≥5 m) so
  estimated and authoritative zones read on one scale, vectorised through the existing contour
  pipeline, and clipped to the query circle.
- **R4.2** Summary statistics (max/mean depth, flooded area, generated/ponded/drained volume,
  depression counts, ocean cells masked, cells despiked) are computed within the circle only.
- **R4.3** Every response carries `Provenance` (`sourceId: estimate.pluvial.scs-cn`), the method
  description with citations, and the `limitations` array — the model consuming this must never be
  handed a number it would be dangerous to paraphrase without its caveats.
