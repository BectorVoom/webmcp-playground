This project uses bun cli.(bun,bunx)


## Guidelines
* MapLibre GL JS Frontend Testing Guidelines
  * 
/Users/ods/Documents/webmcp-playground/docs/guideline/MapLibre GL JS Frontend Testing Guidelines.md


## ERA5 rainfall climatology — spend it carefully

`/api/geo/flood-model` sizes every river from an ERA5 daily-precipitation series
fetched through `server/climate-source.ts`. **It is the scarcest resource in this
repository.** One call asks the Open-Meteo archive for 66 years of daily values,
and the free tier's allowance is weighted by series length, so a few dozen calls
exhaust the whole day for everyone on the machine. Once exhausted, *every*
request is refused regardless of size:

```json
{"reason":"Daily API request limit exceeded. Please try again tomorrow.","error":true}
```

It resets at 00:00 UTC (09:00 JST). There is no way to hurry it, and retrying
does not clear it — back off rather than poll.

* **Reuse before fetching.** The fitted series is kept on disk under
  `CLIMATE_CACHE_DIR` (default `.cache/era5`, git-ignored). A location is asked
  for once and read back on every run after that. Do not disable it, do not
  clear it, and do not point it at a scratch directory — a previous round's
  download was lost exactly that way and cost a day of measurement.
* **A location is keyed to 0.1°**, so nearby query points share one series.
  Warm the sites you need once, then work entirely from disk.
* **Check `climatology.status` before believing or comparing any result.** When
  the archive is unavailable the route silently falls back to area-keyed
  hydraulic geometry. That is not a small difference: trunk bankfull goes from
  244–1 182 m³/s to 23–50, which moves scored flood extent by ~2% and IoU by
  ~0.3 points. **Two runs are not comparable unless both report `ok`.**
  `climatology.retrievedFrom` says `archive`, `stored` or `none`.
* **`GEO_DATA_MODE=fixture` never touches it**, so use fixture mode for anything
  that does not specifically need real river capacity.

Background and measurements: [`docs/geo-sources.md`](./docs/geo-sources.md) and
[`docs/specs/flood-model/plan-stage-reconciliation.md`](./docs/specs/flood-model/plan-stage-reconciliation.md).

## Copernicus retrievals — they are jobs, not requests

The European flood forecast (`/api/geo/cems-forecast`) retrieves from the ECMWF
Data Store, which does not answer a request: it *queues* one. You submit, poll,
and download a file minutes later. Nothing in a request path waits for that, so
the route advances the work by one step per call and reports `pending` until it
is done — never an empty map, because "not fetched yet" and "nothing here will
flood" are the two answers this whole feature exists to keep apart.

* **A cold location costs 31 jobs and takes hours.** The store accepts at most
  **one calendar year per historical request** and queues **one request per
  dataset at a time**, so the 1991–2020 window is 30 retrievals run back to
  back, at roughly ten minutes each when measured. The forecast is a different
  dataset and runs alongside them.
* **The history is asked for once per place, ever.** It is distilled to annual
  maxima in `CEMS_CACHE_DIR` (default `.cache/cems`, git-ignored) and the raw
  years are then deleted. **Do not clear that directory casually** — it is hours
  of somebody's queue time per site, and this is the same bargain, for the same
  reason, as the ERA5 store above.
* **Warm a site before you need it**: `bun tools/warm-cems.ts <lat> <lon>`, and
  go away for a few hours. It is the same code path the route takes with nobody
  waiting on it, and it resumes rather than restarts if interrupted.
* **Do not raise the queue concurrency.** Eight at once was tried; all eight came
  back `rejected` with *"Number queued requests for this dataset is temporarily
  limited. Please configure your scripts accordingly"*. That failure arrives
  *after* the jobs are accepted, so it looks like success until it does not.
* **The account must accept two licences once, in a browser**, or every call is
  refused with `403 user didn't accept all required site policies`. This is not
  a code problem and no retry clears it — see `.env.example`.
* **EFAS is deliberately not used.** It is the better European model, and a
  non-partner token gets it on a ~30-day delay against a 15-day maximum lead
  time, so every forecast such a key can retrieve has already expired. The
  reasoning and the measurement are in [`docs/geo-sources.md`](./docs/geo-sources.md).
* **`GEO_DATA_MODE=fixture` never touches it**, and there is no recorded GloFAS
  ensemble to replay — fixture mode reports the forecast as unconfigured.


## CDS API
https://cds.climate.copernicus.eu/api/catalogue/v1/docs
