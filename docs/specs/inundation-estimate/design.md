# Design — Inundation Depth & Extent Estimation API

- **Status:** Implemented
- **Last updated:** 2026-08-30
- **Inputs:** [`requirements.md`](./requirements.md)

## 1. Pipeline

```
POST /api/geo/inundation-estimate  { at, radiusKm≤20, rainfallMm?, durationHours?, curveNumber? }
        │
        ├─ Precipitation ─ Open-Meteo hourly forecast, 5 samples, accumulated (R3.2)
        │                  — or caller's design storm, no network
        ├─ Terrain ─────── Terrarium DEM tiles z11 via geo proxy → pngjs decode → mosaic (R3.1)
        │                  → despike voids → (ocean mask happens inside the spread) (R3.3)
        ├─ Runoff ──────── SCS-CN (TR-55): P → Q in mm (R2.1)                [runoff.ts]
        ├─ Spreading ───── Priority-Flood + level-pool fill-and-spill:
        │                  Q × cell areas → depth grid, volume-conserving (R2.2–R2.4) [spread.ts]
        └─ Extent ──────── depth grid → GSI bands → per-tile class grids
                           → rasterTilesToFloodZones → clipAndMergeZones (R4.1) [bands.ts]
```

## 2. Module placement

| Piece | Where | Why |
|---|---|---|
| `runoff.ts`, `terrain.ts`, `spread.ts`, `bands.ts` | `src/lib/hydrology/` | Pure, deterministic, unit-testable math with no I/O — same layer as `src/lib/geometry/`. |
| Route + upstream fetching + synthetic fixture terrain | `server/routes/inundation.ts` | The only part that talks to the network or knows about Hono; mounted beside `geoRoutes` on `/api/geo`. |
| PNG decoding | `pngjs` (server-only dependency) | The browser adapters decode with canvas; the server has none. `pngjs` is dependency-free and also encodes, which the route tests use to fabricate Terrarium tiles. |

The route goes through `GeoProxyService.fetchUpstream[Binary]` rather than bare `fetch`, so the
host allowlist, circuit breakers, timeouts and byte caps apply to the two new upstreams exactly as
to every other source. `s3.amazonaws.com` and `api.open-meteo.com` join the default allowlist.

## 3. The spread algorithm (spread.ts)

Single O(n log n) pass, typed arrays throughout, deterministic (heap ties broken by insertion
order):

1. **Ocean mask** — BFS from the domain edge over cells ≤ ocean level marks open water; those cells
   are seeded as outlets. An inland polder below sea level is *not* connected and stays a
   depression. Without this, coastal bathymetry becomes "the deepest flood on the map".
2. **Priority-Flood** from boundary + ocean seeds gives each cell its spill level (`filled`), a
   drainage forest toward the boundary (`parent`), and pop order.
3. **Depression labelling** — connected components of `filled > elev` sharing a bit-identical
   `filled` (exact float copies, so strict equality is correct). Nested sub-basins flatten into
   their maximal depression, which the level-pool step then fills bottom-up anyway.
4. **Routing** — `nextDep[c]`: first depression on c's path to the boundary, resolved in one pass
   because parents pop before children. Each depression's downstream target is `nextDep` of the
   cell it was first entered from — provably outside it and strictly closer to the boundary, so the
   depression graph is a DAG and upstream-first processing is a sort on first-pop order.
5. **Fill and spill** — per depression: available = own catchment runoff + upstream overflow;
   stored = min(available, capacity); overflow cascades. The stored volume becomes a flat surface
   found by sorting the depression's cells by elevation and sweeping.

Known approximations, accepted for a screening model and documented in the response `limitations`:
water within one depression ponds to a single level even when sub-pits are not yet hydraulically
connected; overflow follows the lowest-pass route (the priority-flood entry path), not D8 steepest
descent; there is no timing.

## 4. DEM conditioning (terrain.ts)

- **Despike:** a cell more than 10 m below the *second-lowest* of its 8 neighbours is replaced by
  that value. Second-lowest, not median: a one-cell-wide gorge floor always has an along-valley
  neighbour at its own level and passes, while an isolated void pixel does not — and a *pair* of
  voids heals in one pass. Border cells are exempt so a valley outlet at the edge is never dammed.
  Found the hard way: a −122 m void near Kurashiki reported as a 130 m-deep pond.
- **Grid budget:** ≤ 64 tiles (4.2 M cells). z11 covers a 20 km radius in ≤ ~25 tiles; the zoom
  degrades automatically if a request would exceed the budget (R3.4).

## 5. Fixture mode

`GEO_DATA_MODE=fixture` swaps the DEM for a deterministic synthetic basin *centred on the query
point* (fractional-tile placement, so the ponding falls inside the clipped circle wherever the
rectangle is cut) and defaults the storm to 100 mm. Everything downstream — runoff, spread,
banding, clipping, response shape — is the live code path.

## 6. Verification

- Unit: TR-55 textbook values; tilted plane drains dry; bowl fills to the analytically exact level;
  overflow caps at spill and cascades pit-to-pit; per-row areas keep the surface flat; ocean masked
  vs. polder kept; despike heals voids and spares gorges. Volume conservation asserted throughout.
- Route: validation, fixture pipeline offline, live pipeline against fabricated Terrarium
  tiles/Open-Meteo replies, cache hit, 502 advice.
- Live smoke (2026-08-30): Mabi, Kurashiki (34.647, 133.690, 20 km, 150 mm) → 69 km² ponded,
  max 16 m in valley basins, volume conserved to the cubic metre; Tokyo lowlands with a dry
  forecast → correctly dry.
