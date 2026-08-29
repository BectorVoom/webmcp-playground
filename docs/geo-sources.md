# Geo Data Sources — Survey & Licence Review

This document records the upstream data sources evaluated for the Disaster Safety tool set across the United States (`us`), European Union (`eu`), and Japan (`jp`), covering flood inundation, emergency facilities/shelters, official alerts, and routing.

## Survey Table

| Source ID | Region | Category | Type | Endpoint / Protocol | Auth | Payload Shape | Refresh Interval | Rate Limits | Required Headers | Licence & Terms Link | Licence Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `us.nws.forecast` | `us` | Flood | Forecast | `https://api.weather.gov/gridpoints/{wfo}/{x},{y}` | None | GeoJSON FeatureCollection | 1 hour | ~30 req/min | `User-Agent: (webmcp-playground, contact@example.com)` | [US Public Domain / NWS API Terms](https://www.weather.gov/documentation/services-web-api) | **Approved** (Public Domain, US Gov work) |
| `us.fema.nfhl` | `us` | Flood | Scenario | `https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query` | None | ArcGIS REST GeoJSON / JSON | 6 months | Unthrottled / standard fair use | `User-Agent` | [FEMA Open Data / Public Domain](https://www.fema.gov/about/openfema/terms-conditions) | **Approved** (US Public Domain) |
| `us.fema.shelters` | `us` | Places | Shelters | `https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0/query` | None | ArcGIS Feature JSON / GeoJSON | 30 minutes (during active events) | Standard fair use | `User-Agent` | [FEMA National Shelter System Terms](https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer) | **Approved** (Public Domain) |
| `us.nws.alerts` | `us` | Alerts | Alerts | `https://api.weather.gov/alerts/active` | None | GeoJSON (CAP-derived) | 1 minute | ~30 req/min | `User-Agent: (webmcp-playground, contact@example.com)` | [NWS Alert Terms](https://www.weather.gov/documentation/services-web-api) | **Approved** (Public Domain) |
| `eu.copernicus.efas` | `eu` | Flood | Forecast | `https://emergency.copernicus.eu/mapping/list-of-activations-rapid` / WMS-Vector API | API Token (optional) / Open WFS | GeoJSON / WFS GML | 12 hours | 60 req/min | `Accept: application/json` | [Copernicus Open Access Licence](https://www.copernicus.eu/en/access-data/copyright-and-licences) | **Approved** (Free & open access with Copernicus attribution) |
| `eu.osm.shelters` | `eu` | Places | Shelters / Facilities | `https://overpass-api.de/api/interpreter` | None | Overpass JSON / GeoJSON | Static / Daily | 2 concurrent queries, ~10k req/day | `User-Agent` | [ODbL 1.0](https://www.openstreetmap.org/copyright) | **Approved** (ODbL with required attribution: "© OpenStreetMap contributors") |
| `eu.meteoalarm.alerts` | `eu` | Alerts | Alerts | `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-` / CAP feeds | None | CAP v1.2 XML / JSON atom | 5 minutes | Standard fair use | `User-Agent` | [MeteoAlarm Terms of Use](https://meteoalarm.org/en/live/terms) | **Approved** (Free non-commercial & commercial reuse with attribution) |
| `jp.gsi.flood-l2` | `jp` | Flood | Scenario | `https://cyberjapandata.gsi.go.jp/xyz/hazardmap_flood_l2_shinsuisin_data/{z}/{x}/{y}.png` | None | 256x256 RGBA raster tiles | Static (annual/triennial updates) | Standard GSI tile limits | `User-Agent` | [GSI Content Terms of Use](https://www.gsi.go.jp/kikakukouhou/kikakukouhou40182.html) | **Approved** (Government of Japan open data with attribution: "国土地理院") |
| `jp.gsi.shelters` | `jp` | Places | Designated Evacuation Sites | `https://cyberjapandata.gsi.go.jp/xyz/skhb/{z}/{x}/{y}.geojson` / GSI Shelter API | None | GeoJSON FeatureCollection | Periodic | Standard GSI limits | `User-Agent` | [GSI Open Data Terms](https://www.gsi.go.jp/kikakukouhou/kikakukouhou40182.html) | **Approved** (Attribution required: "指定緊急避難場所データ: 国土地理院") |
| `jp.jma.warnings` | `jp` | Alerts | Alerts & Advisories | `https://www.jma.go.jp/bosai/warning/data/warning/{area_code}.json` | None | JMA JSON (with official English translations) | 1 minute | Fair use (~1 req/s) | `User-Agent` | [JMA Terms of Use](https://www.jma.go.jp/jma/kishou/info/coment.html) | **Approved** (JMA Open Data, English translations available) |
| `global.valhalla.routing` | `all` | Routing | Pedestrian / Bike / Auto | `https://valhalla1.openstreetmap.de/route` or configured `ROUTING_BASE_URL` | None / API Key (if self-hosted or commercial provider) | Valhalla JSON | Real-time | Varies by provider (60 req/min default) | `Content-Type: application/json` | [Valhalla Open Source / OSM Data](https://github.com/valhalla/valhalla) | **Approved** (OSM data attribution required: "© OpenStreetMap contributors") |

## Discarded / Rejected Sources

| Source | Region | Reason for Exclusion |
|---|---|---|
| Proprietary Private Flood APIs | All | Proprietary commercial licensing, prohibitive cost, unredactable credentials. |
| Unofficial Twitter/X Scrapers | All | Violates upstream ToS, unverified veracity, cannot satisfy R8.1 provenance requirements. |
| Non-CAP Regional Weather Feeds | Various | Incompatible data structure without standard severity/urgency metadata. |
