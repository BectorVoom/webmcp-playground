# Tasks — Inundation Depth & Extent Estimation API

- **Status:** Complete
- **Last updated:** 2026-08-30
- **Inputs:** [`requirements.md`](./requirements.md) · [`design.md`](./design.md)

| Id | Task | Reqs | Status |
|---|---|---|---|
| T1 | SCS-CN runoff (`src/lib/hydrology/runoff.ts`) + textbook-value tests | R2.1 | ✅ |
| T2 | Terrarium decode, tile mosaic, per-row cell geometry (`terrain.ts`) + tests | R3.1, R2.4 | ✅ |
| T3 | Priority-Flood + level-pool fill-and-spill (`spread.ts`) + analytic tests | R2.2, R2.3 | ✅ |
| T4 | Ocean mask as outlet seeding; polder-vs-sea test | R3.3 | ✅ |
| T5 | DEM despiking (second-lowest-neighbour, border-exempt) + gorge/void tests | R3.3 | ✅ |
| T6 | Depth banding on the GSI legend, per-tile slicing, in-circle summary (`bands.ts`) | R4.1, R4.2 | ✅ |
| T7 | Route `POST /api/geo/inundation-estimate`: validation, cache, error ladder, fixture terrain, Open-Meteo sampling (`server/routes/inundation.ts`) + route tests | R1.*, R3.2, R3.4, R4.3 | ✅ |
| T8 | Allowlist + `.env.example` + `docs/geo-sources.md` entries for the two new upstreams | R3.1, R3.2 | ✅ |
| T9 | Live smoke verification (Mabi design storm; Tokyo forecast) | R2.3, R3.3 | ✅ |

## Follow-ups (recorded, not planned)

- Wire the estimate into a WebMCP tool / the map UI so an agent can request and render it beside
  the authoritative hazard layers (it already speaks `FloodZone`).
- Spatially varying curve number from a land-cover raster (e.g. ESA WorldCover) would replace the
  single-CN assumption, the largest source of bias inland.
- Cache decoded DEM mosaics keyed on the tile range: the DEM is static, only the storm varies.
