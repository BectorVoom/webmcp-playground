# Geo Data Sources — Survey & Licence Review

This document records the upstream data sources evaluated for the Disaster Safety tool set across the United States (`us`), European Union (`eu`), and Japan (`jp`), covering flood inundation, emergency facilities/shelters, official alerts, and routing.

## Survey Table

| Source ID | Region | Category | Type | Endpoint / Protocol | Auth | Payload Shape | Refresh Interval | Rate Limits | Required Headers | Licence & Terms Link | Licence Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `us.nws.forecast` | `us` | Flood | Forecast | `https://api.weather.gov/gridpoints/{wfo}/{x},{y}` | None | GeoJSON FeatureCollection | 1 hour | ~30 req/min | `User-Agent: (webmcp-playground, contact@example.com)` | [US Public Domain / NWS API Terms](https://www.weather.gov/documentation/services-web-api) | **Approved** (Public Domain, US Gov work) |
| `us.fema.nfhl` | `us` | Flood | Scenario | `https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query` | None | ArcGIS REST GeoJSON / JSON | 6 months | Unthrottled / standard fair use | `User-Agent` | [FEMA Open Data / Public Domain](https://www.fema.gov/about/openfema/terms-conditions) | **Approved** (US Public Domain) |
| `us.fema.shelters` | `us` | Places | Shelters | `https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0/query` | None | ArcGIS Feature JSON / GeoJSON | 30 minutes (during active events) | Standard fair use | `User-Agent` | [FEMA National Shelter System Terms](https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer) | **Approved** (Public Domain) |
| `us.nws.alerts` | `us` | Alerts | Alerts | `https://api.weather.gov/alerts/active` | None | GeoJSON (CAP-derived) | 1 minute | ~30 req/min | `User-Agent: (webmcp-playground, contact@example.com)` | [NWS Alert Terms](https://www.weather.gov/documentation/services-web-api) | **Approved** (Public Domain) |
| `eu.copernicus.glofas-forecast` | `eu` | Flood | Forecast (ensemble, 5-day) | `https://ewds.climate.copernicus.eu/api/retrieve/v1/processes/cems-glofas-forecast/execution` — OGC API Processes; submit, poll, download | Personal access token (`PRIVATE-TOKEN` header) **and** two licence acceptances | Queued job → **GRIB2**, 255 messages (51 members × 5 lead times) on a 0.05° grid | Daily (00 UTC run, published within ~12 h) | One queued request per dataset; a cold location costs 31 jobs, then one a day | `PRIVATE-TOKEN` | [Copernicus Open Access Licence](https://www.copernicus.eu/en/access-data/copyright-and-licences) + [CEMS EWDS Terms of Use](https://ewds.climate.copernicus.eu/licences/terms-of-use-cems) | **Approved** (free reuse with Copernicus/GloFAS attribution; the account must accept both licences once, in a browser) |
| `eu.copernicus.glofas-thresholds` | `eu` | Flood | Climatology (input, not shown) | `.../processes/cems-glofas-historical/execution`, same protocol | Same token and licences | Queued job → GRIB2, one message per day, 1991–2020 | Fixed window; retrieved once per location, ever | **One calendar year per request** and one request queued at a time — 30 jobs per location, once | `PRIVATE-TOKEN` | As above | **Approved** (same licence; used only to fit each cell's flood frequency curve) |
| `eu.osm.shelters` | `eu` | Places | Shelters / Facilities | `https://overpass-api.de/api/interpreter` | None | Overpass JSON / GeoJSON | Static / Daily | 2 concurrent queries, ~10k req/day | `User-Agent` | [ODbL 1.0](https://www.openstreetmap.org/copyright) | **Approved** (ODbL with required attribution: "© OpenStreetMap contributors") |
| `eu.meteoalarm.alerts` | `eu` | Alerts | Alerts | `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-` / CAP feeds | None | CAP v1.2 XML / JSON atom | 5 minutes | Standard fair use | `User-Agent` | [MeteoAlarm Terms of Use](https://meteoalarm.org/en/live/terms) | **Approved** (Free non-commercial & commercial reuse with attribution) |
| `jp.gsi.flood-l2` | `jp` | Flood | Scenario | `https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png` | None | 256x256 RGBA raster tiles | Static (annual/triennial updates) | Standard GSI tile limits | `User-Agent` | [GSI Content Terms of Use](https://www.gsi.go.jp/kikakukouhou/kikakukouhou40182.html) | **Approved** (Government of Japan open data with attribution: "国土地理院") |
| `jp.gsi.shelters` | `jp` | Places | Designated Evacuation Sites | `https://cyberjapandata.gsi.go.jp/xyz/skhb/{z}/{x}/{y}.geojson` / GSI Shelter API | None | GeoJSON FeatureCollection | Periodic | Standard GSI limits | `User-Agent` | [GSI Open Data Terms](https://www.gsi.go.jp/kikakukouhou/kikakukouhou40182.html) | **Approved** (Attribution required: "指定緊急避難場所データ: 国土地理院") |
| `jp.jma.warnings` | `jp` | Alerts | Alerts & Advisories | `https://www.jma.go.jp/bosai/warning/data/r8/{office_code}.json` | None | JMA JSON (area + warning codes; no prose translations) | 1 minute | Fair use (~1 req/s) | `User-Agent` | [JMA Terms of Use](https://www.jma.go.jp/jma/kishou/info/coment.html) | **Approved** (JMA Open Data; feed is Japanese-only — no official translation to quote) |
| `global.osm.nominatim` | `all` | Geocoding | Forward (place name → coordinates) | `https://nominatim.openstreetmap.org/search?q=&format=jsonv2` | None | Nominatim `jsonv2` JSON array | Static / continuous OSM edits | ~1 req/s, no bulk use, caching expected | `User-Agent` identifying the application | [OSM Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/) / [ODbL 1.0](https://www.openstreetmap.org/copyright) | **Approved** (ODbL with required attribution: "© OpenStreetMap contributors"; usage policy honoured by a 24 h server-side cache and a hard result cap) |
| `jp.jma.kikikuru` | `jp` | Flood | **Nowcast** (real-time risk) | `https://www.jma.go.jp/bosai/jmatile/data/risk/{basetime}/{member}/{validtime}/surf/{inund\|flood}/{z}/{x}/{y}.png`, indexed by `.../risk/targetTimes.json` | None | 4-bit palette PNG tiles; index is JSON | 10 minutes | Fair use (~1 req/s) | `User-Agent` | [JMA Terms of Use](https://www.jma.go.jp/jma/kishou/info/coment.html) | **Approved** (JMA Open Data; attribution 気象庁) |
| `global.copernicus.glofas` | `all` | Flood | Scenario (100-year return period) | `https://ows.globalfloods.eu/glofas-ows/ows` — WMS `GetMap`, layer `FloodHazard100y` | **None** (open WMS; the CDS API for GloFAS *does* need an account, this does not) | Palette PNG | Static climatology | Standard fair use | `User-Agent` | [Copernicus Open Access](https://www.copernicus.eu/en/access-data/copyright-and-licences) | **Approved** (free reuse with Copernicus/GloFAS attribution) |
| `global.aws.terrarium` | `all` | Terrain (DEM) | Static elevation | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | None | 256×256 Terrarium-encoded PNG (elevation = R·256 + G + B/256 − 32768) | Static compilation (SRTM/NED/GMTED + bathymetry) | Standard S3 fair use | `User-Agent` | [Mapzen Terrain Tiles on AWS Open Data](https://registry.opendata.aws/terrain-tiles/) | **Approved** (public-domain and ODbL-derived sources; attribution to the source compilation) |
| `global.open-meteo.forecast` | `all` | Precipitation | Forecast | `https://api.open-meteo.com/v1/forecast?hourly=precipitation&forecast_hours=` | None | JSON (one object per sampled coordinate) | Hourly model runs | 10k req/day free, non-commercial | none | [Open-Meteo Terms](https://open-meteo.com/en/terms) | **Approved** (CC BY 4.0, attribution "Weather data by Open-Meteo.com") |
| `global.open-meteo.era5` | `all` | Climatology | Reanalysis (daily precipitation) | `https://archive-api.open-meteo.com/v1/archive?daily=precipitation_sum&start_date=1960-01-01` | None | JSON daily series (~450 KB for 65 years) | Static reanalysis, ~5-day lag | 10k weighted units/day free, non-commercial — a 66-year daily series is heavy enough that a few dozen calls exhaust it, see below | none | [Open-Meteo Terms](https://open-meteo.com/en/terms) | **Approved** (CC BY 4.0; ERA5 via Copernicus, attribution "ERA5 reanalysis via Open-Meteo") |
| `global.osm.embankments` | `all` | Flood defences | Static infrastructure | `https://overpass-api.de/api/interpreter` — Overpass QL, `man_made=dyke\|levee\|embankment`, `embankment=yes`, `barrier=embankment` | None | Overpass JSON with inline way geometry | Continuous OSM edits | 2 concurrent queries, ~10k req/day | `User-Agent` | [ODbL 1.0](https://www.openstreetmap.org/copyright) | **Approved** (ODbL, attribution "© OpenStreetMap contributors") |
| `global.osm.flood-infrastructure` | `all` | Dams, drainage, buildings | Static infrastructure | `https://overpass-api.de/api/interpreter`, with its announced `lambert.openstreetmap.de` backend and the OSM Wiki-listed global `overpass.private.coffee` instance as sequential connection fallbacks — mapped dams; storm/combined sewers, drains and culverts; building ways and relations | None | Overpass JSON with node/way/relation geometry | Continuous OSM edits | One query at a time; each query is capped at 8k infrastructure + 20k buildings, with capped/504 boxes subdivided sequentially and cached | `User-Agent` | [ODbL 1.0](https://www.openstreetmap.org/copyright) | **Approved** (ODbL, attribution "© OpenStreetMap contributors") |
| `global.stadia.routing` | `all` | Routing | Pedestrian / Bike / Auto | `https://api.stadiamaps.com/route/v1` (or `api-eu.` for EU residency), overridable via `ROUTING_BASE_URL` + `ROUTING_ROUTE_PATH` | API key, `?api_key=` (`ROUTING_API_KEY`), attached server-side and redacted in logs | Valhalla JSON (Stadia hosts Valhalla) | Real-time | Per Stadia plan; free tier is generous but not unlimited | `Content-Type: application/json` | [Stadia Maps Routing](https://docs.stadiamaps.com/api-reference/#tag/Routing) over [Valhalla](https://github.com/valhalla/valhalla) / OSM data | **Approved** (attribution required: "© Stadia Maps, © OpenMapTiles, © OpenStreetMap contributors") |

## Implementation Status (verified 2026-08-30)

Every source below was called for real from this repository before being wired in. "Live" means the
adapter calls the upstream through `/api/geo/*`; "fixture" means it still returns recorded data.

| Source ID | Status | Spatial resolution actually achieved | Notes |
|---|---|---|---|
| `jp.jma.warnings` | **Live** | Warning office (58 of them) | Uses the `r8` path. All 58 office codes verified. Hokkaido is 8 offices and Okinawa 4, so the naive `{JIS}0000` code 404s exactly where typhoons land. |
| `us.nws.alerts` | **Live** | Exact point | `alerts/active?point=` resolves the point to NWS forecast zones upstream, so no zone table is needed. |
| `eu.meteoalarm.alerts` | **Live** | Country, refined to polygon where published | 38 country feeds verified. Only some entries carry `cap:polygon`; those are point-tested. The rest are region-coded (NUTS3) and reported as country-wide with coverage saying so. |
| `global.osm.overpass` | **Live** | Exact radius, worldwide | Replaces the three per-region shelter providers. Bare `amenity=shelter` is excluded — in OSM it is overwhelmingly picnic and bus shelters. |
| `global.osm.nominatim` | **Live** | Exact point, worldwide | Verified against the real endpoint on 30 August 2026: "Fukui Station" resolves to the JR station node at 36.0621411, 136.2221908. Two traps it exposed, both now handled — Nominatim returns the tram stop 福井 with *identical* `importance` to 福井駅, and "Springfield" returns five US cities within 0.12 of each other, so relative confidence is scored against the top hit and an ambiguous result deliberately names no next step. |
| `jp.jma.kikikuru` | **Live** | 1 km mesh, z12 tiles, whole query circle | 気象庁 キキクル 浸水害 + 洪水害. The only source here that says what is dangerous **now**; everything else in the Japanese flood path is a planning map with no valid time. Both hazards are queried and merged at the more severe level. Verified against the live endpoint on 30 August 2026 — on a calm day, which is what the recorded fixtures capture. |
| `global.copernicus.glofas` | **Live** | ~1 km global grid, one WMS request per query | Fills the European slot that EFAS left empty, and gives every region a second, independent opinion. `#3338FF` is **permanent water**, not hazard — sampling showed it covering 54% of Lake Biwa and under 2% of the Fukui flood plain — so it is excluded from the extent rather than reported as somewhere that will flood. |
| `jp.gsi.flood-l2` | **Live** | Raster tiles at z14, whole query circle | Tiles are classified against the published depth legend and vectorised. Needs a canvas to decode PNG; falls back to fixtures where there is none. Decoded with `colorSpaceConversion: 'none'` — the tiles carry sRGB/gAMA chunks and colour-managed decoding would shift palette values past the classifier's tolerance. A 20 km query needs 441 tiles at this zoom and `GEO_TILE_CAP` defaults to 512, so the whole circle is covered; the working cell scales with the radius (40 m close in, 120 m at 20 km) to hold the rendered layer inside its vertex budget. |
| `us.fema.nfhl` | **Live (unverified upstream)** | Query envelope | Built to FEMA's ArcGIS REST contract and tested against payloads in that shape. `hazards.fema.gov` accepted TLS but returned no body from the network this was developed on, so the live call itself is untested. |
| `global.aws.terrarium` | **Live** | z11 tiles (~60–75 m cells), whole query rectangle | DEM input to `POST /api/geo/inundation-estimate`. Decoded server-side with `pngjs` (no canvas on the backend). Conditioned before use: void pixels far below their neighbourhood are despiked, and sea cells (≤ 0 m, edge-connected) are masked as outlets — both verified against real tiles around Kurashiki, where an unconditioned run reported a −122 m void as a 130 m-deep flood. |
| `global.open-meteo.forecast` | **Live** | 5 sample points across the query circle, hourly forecast | Precipitation input to the same endpoint; accumulated over the requested window and averaged across samples. Verified live on 30 August 2026 (a dry Tokyo forecast, which correctly produced a dry estimate). A caller-supplied `rainfallMm` design storm bypasses it. |
| `global.open-meteo.era5` | **Live** | Single point per query, 1960–last complete year | Rainfall climatology for `POST /api/geo/flood-model`: an annual-maximum daily series, Gumbel-fitted, gives the local 2-year rainfall, which sizes every channel's bankfull discharge. Verified 2026-08-30 — 66 complete years at each of the five flood sites, 2-year daily rainfall 64.4–106.4 mm. This replaced area-keyed hydraulic geometry, which understated large-river capacity by two to four orders of magnitude. Point rainfall is used without an areal-reduction factor, which slightly overstates capacity on large catchments. |
| `global.osm.embankments` | **Live** | Vector ways over the model domain | Barrier layer for `POST /api/geo/flood-model`. Coverage is uneven and is reported per query: measured 2026-08-30 it ran 1,185 ways near Mabi, 634 near Joso, 155 near Nagano, 145 near Hitoyoshi, 81 near Fukui. Not one way in any of those areas recorded a `height`, so crests use the 5 m default. Road and rail embankments are included deliberately — barriers by construction. Overpass needs tens of seconds for a 40 km box, hence the per-call proxy timeout override. GSI's 治水地形分類図 (`lcmfc2`, verified present at z14–16) would be a better Japanese source but needs colour-legend decoding. |
| `global.osm.flood-infrastructure` | **Live; field-verified at Joso** | Sub-grid geometry over the model domain | Input to `POST /api/geo/flood-model`. Dams get only finite storage supported by mapped upstream normal-pool area; mapped drains/sewers remove only a capacity-limited local runoff volume; building footprint fraction displaces cell storage. Linear infrastructure and buildings use independent capped GET queries and resumable subdivision trees below `WATER_CACHE_DIR/infrastructure`; partial results are reported and are not kept in the whole-model response cache. Verified complete at Joso on 2026-09-02: 6 dams, 4,052 drains and 231,820 deduplicated buildings. Mabi hit both caps and the remaining verification was stopped rather than scoring an incomplete layer; see [`plan-infrastructure-precision.md`](./specs/flood-model/plan-infrastructure-precision.md). Underground sewer coverage is inherently uneven, so cross-place comparisons must compare these diagnostics. |
| `eu.copernicus.glofas-forecast` | **Live (needs a token)** | 0.05° grid (~3.5 km at European latitudes), whole query box | The European forecast slot, filled at last. Verified end to end against the live store on 2026-08-31 — retrieval, decode, threshold fit and route — at Cologne; the numbers are in **Validation at Cologne** below. Four things about the store were found the hard way and are worth knowing before changing any of this: see **Copernicus retrieval constraints**. |
| `eu.copernicus.efas` | **Rejected for forecasting** | — | EFAS is the European product proper — 1.5 km, purpose-built — and a non-partner token gets it with a **30-day delay**: measured 2026-08-31, the catalogue's temporal extent ended 2026-07-27 while GloFAS's ended that same day. Its longest lead time is 15 days, so every EFAS forecast this key can retrieve expired a fortnight before it arrives. "The real-time data is only available to EFAS partners" is the dataset's own wording. A forecast of the past is not a forecast, so the slot is filled by GloFAS instead. Floods Directive hazard maps remain held nationally in 27 formats. |
| `us.nws.forecast` | **Fixture** | — | NWS river-flood inundation is published as gridded AHPS products, not a point-queryable zone service. Kept on fixtures and labelled as simulated rather than dressed as an NWS product. |
| `us.fema.shelters` | **Withdrawn** | — | Superseded by Overpass. The Open Shelter service only carries shelters opened for an active declared event, so it is empty almost everywhere almost all the time. |
| `jp.gsi.shelters` | **Withdrawn** | — | Superseded by Overpass; the `skhb` tile endpoint is per-prefecture GeoJSON with no national index. |

## Two palettes, both read out of the services' own bytes

Neither of these tables was transcribed from documentation. The last one in this codebase that was
turned out to be wrong on five of its six rows, so both were taken from the pixels instead.

### 気象庁 キキクル risk levels

The tiles are 4-bit palette PNGs, and the `PLTE` chunk carries the whole table **whatever the tile
contains** — so the palette is readable from a tile captured on a completely calm day, which is what
`fixtures/geo/jp/flood/upstream/jma-kikikuru-palette-z10.json` is for. A test pins the legend against
that recording.

| Colour | Level | Meaning |
|---|---|---|
| *(transparent)* | 1 | 今後の情報に注意 — no risk indicated |
| `#F2E700` | 2 | 注意 |
| `#FF2800` | 3 | 警戒 |
| `#AA00AA` | 4 | 危険 |
| `#0C000C` | 5 | 災害切迫 |

Two traps found on the way in:

- The `jmatile` risk index stamps **UTC**, while most of JMA's other `bosai` JSON is JST. Read as
  JST every reading lands nine hours in the past — a plausible number that marks a feed thirty
  seconds old as badly stale. Confirmed against the wall clock: the index served `20260830013000`
  at 10:31 JST, which is 01:31Z.
- JMA answers **404** for a tile with nothing to say. Counting that as a failure made a calm day
  read as an outage.

### Validation at Cologne

The whole European chain was run against the live store on 2026-08-31 — 30 years of history, the
current forecast run, the Gumbel fit and the route — for a 20 km query at 50.94, 6.96. It produced
a 12×8 box of 0.05° cells, and four independent things about it came out right.

**The fitted flood frequency matches the published gauge.** The six cells carrying the Rhine fit:

| | Q2 | Q5 | Q20 |
|---|---|---|---|
| Fitted here, from GloFAS 1991–2020 | **6 041** | 7 760 | **9 990** m³/s |
| Köln gauge, published | MHQ ≈ 6 000 | — | HQ20 ≈ 9 700–10 000 m³/s |

That is the end-to-end check: a wrong sign-magnitude scale factor, a missed reference value or a
mis-grouped annual maximum would not land within 1% of the real thing.

**The river runs the right way.** Those six cells trace a channel from (row 6, col 7) in the
south-east to (0,3) in the north-west, with discharge rising slightly downstream — 6 007 → 6 041 —
which is both the Rhine's actual direction past Cologne and what a river must do.

**Seasonality is right.** The same cells read ~1 131 m³/s in the 2026-08-31 forecast (late-summer
low flow, ensemble spread 1 124–1 142 at one day's lead) against 2 505 m³/s on 1 January 2020 in
the reanalysis.

**And the answer was "no flood", said properly.** At ~1 131 m³/s against a two-year level of
6 041, no cell exceeds anything, so the route returned `ready` with **zero zones** and a coverage
statement saying no cell is forecast above its two-year flood in the next five days — rather than
an empty map that would read as the same thing whether it had been queried or not.

One caveat the run exposed: 95 of the 96 cells got a fitted curve, but 34 of those have a two-year
level under 5 m³/s — ditches and field drains, at the bottom of what a 0.05° model can say anything
about. `minimumBankfullM3PerS` in `glofas-grid.ts` is the knob; the coverage text names the limit.

### Copernicus retrieval constraints

Four properties of the ECMWF Data Store shaped `server/cems/` more than any design decision did.
All four were measured against the live API on 2026-08-31, and all four are invisible until you
try — the documentation and the request schema promise none of them.

1. **`data_format: netcdf` is NetCDF-4, not classic.** The store converts its GRIB with `cfgrib`,
   and the result starts `89 48 44 46` — HDF5, needing a library to read. Its **`grib2` output for
   the same request is grid definition template 3.0 with data representation template 5.0, simple
   packing**: uncompressed, unambiguous, and a few hundred lines to decode. That is why this
   pipeline asks for GRIB2 and `server/cems/grib2.ts` exists instead of a dependency.

2. **The product definition templates are ECMWF-local and differ per dataset.** The forecast uses
   PDT **73**, the historical reanalysis PDT **72**, and neither follows the common octet 10–34
   layout — read `forecastTime` at the standard offset and it comes back as 83 886 080. The two
   fields that matter, the end-of-interval timestamp and the perturbation number, sit at offsets
   recorded in `PRODUCT_LAYOUTS`. An unlisted template is refused rather than read at a guess,
   because a wrong offset yields plausible numbers rather than an error.

3. **A historical request may cover one calendar year.** Two years is refused outright with
   `Your request is too large, please reduce your selection`, and so are three and five. The
   1991–2020 window is therefore 30 retrievals.

4. **Only one request per dataset may be queued at a time.** Submitting eight at once had all eight
   accepted and then `rejected` during execution, with the reason only visible in the job's own
   traceback: *"Number queued requests for this dataset is temporarily limited. Please configure
   your scripts accordingly"*. Note the shape of that failure — accepted at submission, refused at
   execution — which is why `rejected` is a job state the service handles rather than treating as
   finished. The forecast and the history are different datasets and do not compete, so they are
   retrieved alongside each other.

Together these make a cold location **31 jobs**, run largely one after another, and that is what
`CEMS_CACHE_DIR` and `bun tools/warm-cems.ts` exist for. It is paid once per place: afterwards only
the daily forecast run is retrieved, and the 1991–2020 maxima are never asked for again.

### GloFAS `FloodHazard100y`

MapServer quantises a fresh palette per request, so the colours were read from the `PLTE` of actual
`GetMap` responses and then **probed to find out what each one means**:

| Sample | `#3338FF` | pale blues |
|---|---|---|
| Lake Biwa (a permanent lake) | 54.3% | 0.6% |
| Fukui flood plain | 0.8% | 15.0% |
| Dhaka delta | 1.7% | 77.7% |
| Open ocean | — | — |

So `#3338FF` is the permanent water body the layer's own abstract mentions, and the paler blues are
the 100-year inundation extent. Painting the deep blue as hazard would report Lake Biwa as an area
that is going to flood. The shades are **not** read as a depth ramp: GloFAS documents this layer as
an extent and publishes no depth bands for it, so inventing one would be inventing the one thing a
reader would most want to be true.

The service advertises WMS 1.3.0 and then answers a 1.3.0 `GetMap` with `cannot unpack non-iterable
NoneType object` — its own internal error. Requests go out as **1.1.1 with EPSG:4326**.

## What fixture mode actually covers

`GEO_DATA_MODE=fixture` is the shipped default, so it decides what someone sees on a fresh clone.
The Japanese flood fixture (`fixtures/geo/jp/flood/normal.json`) carries two recorded areas:

| Area | Contents |
|---|---|
| Fukui | 24 polygons of real GSI 洪水浸水想定区域（想定最大規模） geometry, captured 2026-08-30 for a 20 km radius around Fukui Station and generalised to ~165 m — the six largest pieces per depth band |
| Tokyo | Two synthetic squares, kept because the conformance suite queries the JP region centre |

A query more than `radius + 20 km` from a recorded area returns **no zones** and says which mode to
switch to. It must never synthesise a polygon under the user: an earlier version did, and told every
user in Japan they were standing in a 3–5 m inundation zone that did not exist.

The Fukui recording reproduces the live answer for the reference scenario — both report the station
inside a 3–5 m band with the nearest zone edge 245 m west — which is what a fixture is for.

## The GSI depth legend is not what the documentation implies

Verified 30 August 2026 by decoding real tiles from `01_flood_l2_shinsuishin_data` at 15 locations
(Fukui, Edogawa, Katsushika, Koto, Arakawa, Saitama, Nishiyodogawa, Amagasaki, Nobi, Wanouchi,
Kurashiki, Mabi, Hitoyoshi, Saga, Chikugo) and at zooms 11–14. GSI paints these tiles in flat
palette colours with **no anti-aliasing**, and 100% of opaque pixels matched this table exactly at
every zoom:

| Colour | Band | Hazard class |
|---|---|---|
| `#F7F5A9` | 0.5 m未満 | low |
| `#FFD8C0` | 0.5–3.0 m | moderate |
| `#FFB7B7` | 3.0–5.0 m | high |
| `#FF9191` | 5.0–10.0 m | extreme |
| `#F285C9` | 10.0–20.0 m | extreme |
| `#DC7ADC` | 20.0 m以上 | extreme (not observed in the sample; from the published legend) |

The table this replaced was a transcription, and **only one of its six colours (`#F7F5A9`) occurs in
a GSI tile at all** — where it also carried the wrong band. On real data the effect was that
`<0.5 m` read as `0.5–3.0 m`, `5–10 m` read as `3–5 m`, and the two deepest bands matched nothing
and were discarded as unreadable. Two of six bands happened to land correctly, which is roughly what
you would expect from a table nobody had checked against a pixel.

The tolerance was 45 in RGB distance while the closest two legend colours are 31 apart, so it could
pull a pixel across a band boundary on its own. It is now 12, which is ample for flat palette fills.

Two further colours occur in GSI's own tiles and appear in no published legend — `#F8E1A6` and
`#FFFFB3`, under 1% of mapped area. They are classified as unreadable and reported in coverage
rather than guessed at; see `docs/specs/disaster-safety/tech-debt.md` §1a.

## Endpoint hazard: the ERA5 archive's daily cap, and what it degrades to

The rainfall climatology behind every river's bankfull capacity comes from the
Open-Meteo ERA5 archive. The free tier's daily allowance is weighted by the size
of the series requested, and this one asks for 66 years of daily values in a
single call; a few dozen calls in a day is enough to get

```json
{"reason":"Daily API request limit exceeded. Please try again tomorrow.","error":true}
```

for every subsequent request, however small, until 00:00 UTC.

Two consequences worth knowing before relying on it.

**The failure is silent in the result, not in the logs.** `loadRainfallClimatology`
is best-effort by design, and on failure `/api/geo/flood-model` falls back to
area-keyed hydraulic geometry. That is not a small difference: measured across
the four hindcast sites, trunk bankfull goes from 244–1 182 m³/s on the ERA5 path
to 23–50 m³/s on the fallback, which moves scored flood extent by about 2% and
IoU by 0.3 points. `climatology.status` reports which path was taken, and any
comparison between two model runs is void unless both say `ok`.

**One fetch per location, ever.** The fitted series is kept on disk under
`CLIMATE_CACHE_DIR` (default `.cache/era5`, git-ignored) as well as in memory,
so a location is asked for once and read back on every run after that —
including runs made while the cap is exhausted, which then take the ERA5 path
rather than the fallback. `climatology.retrievedFrom` says which of the three it
came from: `archive` for a live fetch, `stored` for the same data read back, and
`none` when there is no series and the model is on area-keyed geometry.

What is stored is the annual-maximum series rather than the fitted return level.
It is 66 numbers either way, and keeping the series means a change to the
extreme-value fit is picked up on the next run instead of being frozen into a
cached answer. A failed fetch is never stored, so an outage cannot pin the model
to its fallback. The key includes the year range, so the record is re-asked once
a year when it grows, and not otherwise.

Before this existed, a restart threw the climatology away and a validation
campaign could spend the whole day's allowance without finishing — which is what
happened during round seven.

## Endpoint hazard: the frozen JMA warning feed

`https://www.jma.go.jp/bosai/warning/data/warning/{code}.json` — the path most documentation still
gives — **stopped being republished on 26 May 2026**. It has not been withdrawn: it answers `200`,
with valid JSON, in the documented schema, for all 58 office codes. It is simply frozen, and its
`last-modified` header says so.

This was caught the hard way. Reading it on 30 August 2026 reported "nothing in force" for Fukui at
the moment Fukui was under a level 5 大雨特別警報 (JMA press release
[20260830_ooame_tokukei](https://www.jma.go.jp/jma/press/2608/30a/20260830_ooame_tokukei.html)).
The current feed is `data/r8/{office_code}.json`, which JMA's own warning map reads.

Two defences now exist, because "check the URL more carefully" is not one:

- `JpAlertsProvider` computes the age of the newest bulletin and, past 30 days, reports
  `staleness.stale` with a coverage note naming a possibly dead endpoint. A one-minute-refresh feed
  that has not moved in a month is far likelier dead than calm.
- Unrecognised warning codes pass through with their code and the bulletin's verbatim prose instead
  of being dropped, and sort above known advisories. Codes 09, 29, 43 and 48 are live in the
  national feed today and appear in no published table this was built from.

Whether `r8` is a format revision or 令和8年 is unresolved: `r6`, `r7`, `r9` and `r10` all 404, so
there is no second data point. If it is the year, this breaks on 1 January 2027 — and the staleness
check above is what would surface that, loudly, rather than as silent all-clears.

## Discarded / Rejected Sources

| Source | Region | Reason for Exclusion |
|---|---|---|
| Proprietary Private Flood APIs | All | Proprietary commercial licensing, prohibitive cost, unredactable credentials. |
| Unofficial Twitter/X Scrapers | All | Violates upstream ToS, unverified veracity, cannot satisfy R8.1 provenance requirements. |
| Non-CAP Regional Weather Feeds | Various | Incompatible data structure without standard severity/urgency metadata. |
