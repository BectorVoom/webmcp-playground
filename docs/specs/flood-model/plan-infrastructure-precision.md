# Mapped infrastructure — precision verification

**Measured:** 2026-09-02  
**Status:** one event admissible; three-event completion blocked by Overpass availability

## Method and acceptance gates

The comparison uses the existing 100 m hindcast lattice and the official GSI
event extent, with identical storm, DEM, levee, permanent-water and climatology
inputs on both arms. The control explicitly sets `useDams`, `useStormSewers`
and `useBuildings` false; the candidate explicitly enables all three with the
shipped parameters (0.5 m reservoir drawdown, 15 mm/h drainage within 100 m,
and 0.8 maximum building fraction).

A run is scored only when:

- `climatology.status === "ok"` and `retrievedFrom !== "none"`;
- embankment and standing-water sources are `ok`;
- infrastructure is `ok` and `truncated === false`; and
- polygon area agrees with reported grid area within 1%.

The harness now enforces the infrastructure gate itself. This also rejects old
cached responses that predate the field.

## Admissible result: 2015 Kinugawa/Joso

Joso read its 66-year ERA5 fit from disk and completed the OSM source at 6 dams,
4,052 drainage features and 231,820 building footprints. Polygon/grid area was
0.9981×.

| Arm | IoU | POD | Precision | Model area |
|---|---:|---:|---:|---:|
| Previous behavior | 24.036% | 82.303% | 25.346% | 398.220 km² |
| Dams only | 24.036% | 82.303% | 25.346% | 398.178 km² |
| Drainage only | 24.169% | 82.274% | 25.497% | 395.026 km² |
| Buildings only | 24.036% | 82.303% | 25.346% | 398.228 km² |
| All infrastructure | 24.169% | 82.274% | 25.497% | 394.999 km² |

At this event, the combined change is **+0.151 percentage points precision**,
**+0.133 pp IoU**, **−0.029 pp POD**, and **−3.221 km²** modeled extent. The
measurable extent gain comes entirely from storm drainage, which captured
70,945,302 m³ of local event runoff. Six dams retained 663,334 m³ and building
storage displaced depth in 10,642 cells, but neither moved a 100 m binary score.

This is evidence of a small improvement at one site, not enough evidence to
claim a general precision improvement. Current OSM geometry also postdates the
2015 event, and the 15 mm/h drainage capacity is an explicit assumption rather
than an observed network rating.

## Unscored events and retrieval findings

Mabi's first combined response hit both independent caps: 109 dams plus 7,891
drainage elements (8,000 total), and 20,000 buildings. It is therefore refused,
not scored. Nagano and Kuma were not started after repeated 500/502/connection
failures on three sequential Overpass hosts; treating those failures as empty
infrastructure would manufacture a comparison.

The verification exposed and fixed five retrieval defects:

1. capped boxes are recursively subdivided and cross-boundary features deduplicated;
2. completed children and partial parent markers are persisted, so interrupted
   runs resume instead of repeating large queries;
3. partial infrastructure responses are not retained in the whole-model cache;
4. fallback hosts have independent circuit breakers and transient 5xx/429/
   connection failures use bounded backoff; and
5. linear infrastructure and buildings now have separate GET queries, caps and
   cache trees, so subdivision of one layer does not repeatedly fetch the other.

Resume the remaining verification after Overpass recovers by warming the exact
model boxes with `bun tools/warm-infrastructure.ts <minLon> <minLat> <maxLon>
<maxLat>`, then rerun the two explicit hindcast arms. Do not relax the acceptance
gate to turn a retrieval outage into a precision result.
