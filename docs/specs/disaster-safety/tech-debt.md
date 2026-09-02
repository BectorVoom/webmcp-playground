# Technical Debt Log: Disaster Safety Subsystem

This document records architectural compromises, temporary stubs, and future refactoring opportunities noted during the implementation of the Disaster Safety extension.

---

## 1. Raster Contour Vectorization
- **Context:** `src/lib/geometry/contour.ts` converts GSI raster tiles to GeoJSON polygons on the client: pixel runs per depth class, coalesced into maximal rectangles, dissolved with one `union` pass per class.
- **Fixed 2026-08-30 — the union loop.** It previously called `union` once per pixel run against a running accumulator. That is quadratic, and one real tile from central Fukui holds ~4 700 runs, so `zonesWithin` never returned and the flood layer was never drawn. The synthetic tiles in the suite — a solid block a few pixels across, four runs — finished instantly, so nothing caught it. Real tiles are now recorded in `fixtures/geo/jp/flood/upstream/` and a timing assertion covers the path.
- **Working resolution scales with the query.** Vectorisation coarsens to a cell chosen from the radius (`cellMetresForRadius`: 40 m close in, 120 m at 20 km), taking the most severe class in each cell so a coarser grid can never report shallower water than the source. At z14 a pixel is ~9 m, finer than any question asked of this data and roughly ten times the vertices the rendered layer is allowed (N5).
- **Why it scales rather than sitting at 40 m.** Vertices after simplification track the *number* of polygons, not their intricacy — Douglas-Peucker will not take a ring below four points, so 13 000 rings is ~53 000 vertices at any tolerance. Ring count grows with area over cell², so a fixed cell means the vertex budget decides how much area may be examined. Holding the cell proportional to the radius decouples the two, which is what let `GEO_TILE_CAP` rise from 64 to 512 and the widest query go from 15% of its own circle to 100%.
- **Known cost of that trade.** At 20 km the cell is 120 m, so facility risk near a zone edge is assessed against a 120 m grid; the coarsening direction is conservative (a shelter within a cell of mapped water reads as at risk) but it will overstate at the margin. A close-in query is unaffected — it stays at 40 m.
- **Classification is memoised per distinct colour.** GSI tiles hold four or five palette colours, so classifying all 14 million pixels of a 20 km query individually cost ~1.9 s and was the single largest item once the cap was raised; keyed on the packed RGBA word it is ~175 ms for the same output.
- **The vertex floor is now handled rather than only described.** The observation above — that vertices track polygon *count*, not intricacy, so *n* rings cost ~4n vertices at any tolerance — was recorded here as a property of the approach. It became a defect once something tried to draw a 7 685-part extent, and `dropSmallestPartsToBudget` is the answer; see §1f. `fitZonesToMapBudget` also reorders the two steps when the part count alone rules simplification out, which took a 6 000-part fit from eight seconds to under one by not running fifteen tolerance doublings against already-minimal rings.
- **Future Enhancement:** For large multi-tile views, move raster vectorization to a Web Worker, or serve pre-vectorised GeoJSON/PMTiles from the backend, to keep the main thread free (N3's 50 ms rule is still not enforced per chunk).

## 1a. GSI legend colours outside the published legend
- **Context:** Two fill colours occur in `01_flood_l2_shinsuishin_data` that appear in no published GSI depth legend: `#F8E1A6` and `#FFFFB3`. In a 15-tile national sample they were under 1% of mapped area, concentrated around Amagasaki and the lower Arakawa, and they form solid regions rather than anti-aliased edges (74–77% of their neighbours share the colour), so they are real fills and not decoder artefacts.
- **Decision:** They classify as `unclassified` — drawn as inundated, with the depth reported as unreadable, and counted into a coverage note. Bucketing them into an adjacent band would be a guess about water depth (R8.3).
- **Next step:** Confirm with GSI which product or vintage paints them, then either add them to the legend or keep them unreadable on purpose.

## 1b. Hazard colours had two sources of truth
- **Context:** `adapters/map/maplibre.ts` and `ui/map/Legend.tsx` each carried their own hazard-class colour list, and they disagreed on **every band** — the map painted `extreme` `#7f1d1d` (dark maroon) where the legend showed purple, and `low` `#22c55e` (green) where the legend showed pale yellow. `unclassified` appeared on the map as grey and in the legend not at all.
- **Why it surfaced late:** `extreme` almost never reached the screen. Until the GSI depth legend was corrected, 5–10 m water was misfiled as `high` and the 10–20 m and 20 m+ bands matched nothing and were dropped. Fixing the palette made `extreme` render for the first time, and with it a brown that the legend did not define.
- **Fixed 2026-08-30.** `src/lib/hazard-palette.ts` is now the only place a hazard class is given a colour; the map builds its `match` expressions from it and the legend renders its swatches from it. Tests assert both sides against the table, so a class added without a colour, or a colour changed on one side, fails.

## 1c. R5.7 asks for more than colour — fixed 2026-09-01
- **Context:** R5.7 requires hazard class to be encoded "by more than colour alone" and to stay legible under common colour-vision deficiencies. The flood layer distinguished bands by fill colour only, and the ramp ran green → yellow → red → dark maroon, which is exactly the axis a red-green deficiency compresses. `low` was drawn `#22c55e`, a green close to the `#16a34a` that means "shelter assessed clear" on the same map — so one green meant *shallow flooding* and another meant *safe*.
- **Fixed, in two parts.** Every class now carries a `hatch` in `HAZARD_PALETTE` — cross, diagonal, back-diagonal, dots, horizontal — drawn as a second `fill` layer over the coloured one. A second layer rather than a `fill-pattern` on the first, because a pattern *overrides* `fill-color`: one patterned layer would encode class in texture instead of colour, trading one single-channel encoding for another. The textures differ in direction *and* spacing, so they stay apart in greyscale. And the ramp is now a sequential yellow-orange-red (`#fed976 → #fd8d3c → #e31a1c → #800026`), monotonic in lightness and carrying no green at all, so the collision with "shelter clear" is gone.
- **The legend follows the same table.** `hatchCss` derives the swatch texture from the same `hatch` field the map's raster pattern is built from, so a class cannot be hatched one way on the map and another in the legend — the drift that §1b existed to end.
- **One trap worth knowing:** a `fill-pattern` naming an image the map does not hold draws **nothing at all** — not even the fill beneath it — and MapLibre only warns. The hatches are therefore registered on `load`, before any patterned layer is added, and `FakeMap` models the sprite atlas so a regression fails the suite rather than blanking the map.

## 1f. A quarter of the modelled extent is too speckled to draw
- **Context:** `/api/geo/flood-model` output is now drawn on the map (`inundation-model` layer). A 20 km run is 31 000–68 000 vertices against a 20 000 rendered budget, and simplification alone cannot close that: Douglas-Peucker will not take a ring below four points, so an extent of *n* disjoint parts costs ~4n vertices at *any* tolerance. Carlisle is 7 685 parts and bottoms out at 38 725 vertices — the floor §1 predicted, reached in practice.
- **Resolution:** `dropSmallestPartsToBudget` removes whole parts, largest kept first, until the geometry fits. The largest part of every depth band is always kept, so a band cannot vanish and turn "too speckled to draw" into "no water of this depth here".
- **Known cost, measured 2026-09-01:** Carlisle keeps 205 of 7 685 parts and drops 49.2 km² of 174.7 (**28.1%**); Cedar Rapids keeps 987 of 7 504 and drops 27.0 km² of 119.3 (**22.6%**). Most of that is sub-pixel speckle that conveyed nothing on screen, but it is real modelled water and the tool's summary states the figure rather than absorbing it into the word "simplified".
- **Next step:** the speckle is an artefact of vectorising a raster per depth class. A morphological open (erode-then-dilate) on the classified grid *before* vectorisation would remove the same fragments at source, cost no mapped area worth the name, and leave a far smaller polygon count to draw — a better fix than discarding polygons after the fact.

## 1d. キキクル has only ever been seen quiet
- **Context:** `jp.jma.kikikuru` was built and verified on 30 August 2026, when there was no 浸水害 or 洪水害 risk above level 1 anywhere in Japan. Every live call returned a correct, empty answer.
- **What that does and does not cover:** the palette is not a guess — it comes from the `PLTE` chunk of JMA's own tiles, which carries the whole risk table even in an empty tile, and a test pins it to a recording. The classification of a *populated* tile, though, has only been exercised against synthetic tiles painted in those verified colours.
- **Next step:** capture a real tile during an active event and add it as a fixture. Until then, a colour outside the palette classifies as `unclassified` and is reported, rather than being bucketed into a risk level.

## 1e. Per-source staleness is reported as one flag
- **Context:** `HazardSnapshot` carries a single `staleness`, but Japan now queries a ten-minute nowcast alongside a timeless planning map. A キキクル reading that has aged past its cycle raises "Flood data is STALE" over a summary whose zones are GSI's, which have no valid time to be stale against.
- **Mitigated, not fixed:** キキクル's threshold is three refresh cycles rather than two, so normal publishing lag no longer trips it. The presentation problem remains.
- **Next step:** carry staleness per source into the summariser, so the warning names which product has aged.

## 2. Dynamic Basemap Tile Styles
- **Context:** `src/adapters/map/maplibre.ts` uses an in-memory fallback style when no external vector tile server URL is configured (`GEO_BASEMAP_STYLE_URL`).
- **Future Enhancement:** Provide bundled offline vector styles and sprites for dark mode and high-contrast emergency display.

## 3. Real-time Multi-Language Alert Localization
- **Context:** JMA alerts in Japan provide Japanese text and official JMA English translations when published. When no official translation is provided by the issuing meteorological service, the system preserves verbatim native language without attempting machine translation (ADR-5).
- **Future Consideration:** When official translations are missing from non-English sources (e.g. German MeteoAlarm alerts), continue strictly adhering to ADR-5 to avoid catastrophic model hallucinations in safety-critical advisories.
