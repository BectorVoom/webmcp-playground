/**
 * Finding the Copernicus data-store token, in the several places it is kept.
 *
 * The token is a personal access token for an ECMWF/Copernicus account. Copernicus's own tooling
 * (`cdsapi`) keeps it in a `~/.cdsapirc` file that is neither JSON nor dotenv but two colon-headed
 * lines:
 *
 * ```
 * url: https://cds.climate.copernicus.eu/api
 * key: 01234567-89ab-cdef-0123-456789abcdef
 * ```
 *
 * That matters here because a `.env` file is read as `NAME=value` lines, so a `.cdsapirc` block
 * pasted into one is not skipped with a warning — it is skipped silently, and the server comes up
 * looking correctly configured with no token at all. So the block is parsed deliberately rather
 * than left to a loader that will never see it.
 *
 * **The `url:` line is not used for the flood data, on purpose.** It points at the Climate Data
 * Store, and the CEMS flood forecasts are not there: they were moved to the ECMWF Data Store at
 * `ewds.climate.copernicus.eu`, whose catalogue is the only one carrying `cems-glofas-forecast`.
 * The same account token authenticates against both, so the key is taken from wherever it is kept
 * and the store URL comes from `CEMS_API_URL` instead.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The ECMWF Data Store: where CEMS-Flood (GloFAS, EFAS) actually lives. */
export const DEFAULT_CEMS_API_URL = 'https://ewds.climate.copernicus.eu/api'

export interface CemsCredentials {
  readonly apiUrl: string
  readonly key: string
  /** Which of the several places the key came from, so a wrong one can be found and fixed. */
  readonly keySource: string
}

/**
 * The `key:` value out of a `.cdsapirc`-format text, or undefined.
 *
 * Two generations of token exist. The pre-2024 CDS wrote `key: <uid>:<api-key>`; the current
 * store issues a bare UUID and rejects the `uid:` prefix. Both are accepted here and normalised to
 * what the current API wants, because a key copied from an old set of instructions otherwise fails
 * as a 401 with nothing to say why.
 */
export const parseCdsApiRc = (text: string): { url?: string; key?: string } => {
  const result: { url?: string; key?: string } = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(url|key)\s*:\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    const [, field, rawValue] = match
    if (field === 'url') result.url = rawValue!.replace(/\/$/, '')
    // `12345:uuid` is the legacy shape; keep only the token half.
    else result.key = /^\d+:/.test(rawValue!) ? rawValue!.slice(rawValue!.indexOf(':') + 1) : rawValue!
  }
  return result
}

const readIfPresent = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export interface ResolveOptions {
  /** Files to search, in order, for a `.cdsapirc` block. Overridable so tests never read `$HOME`. */
  readonly rcPaths?: ReadonlyArray<string>
}

/**
 * The token, from the first place that has one.
 *
 * `CEMS_API_KEY` wins because an explicit environment variable is what someone reaches for when
 * they want to override a file, and losing to a stale `~/.cdsapirc` would make that impossible.
 * Returns undefined rather than throwing: no token is a perfectly ordinary configuration — the
 * European forecast is then reported as unconfigured, exactly like an unset routing key.
 */
export const resolveCemsCredentials = (
  env: Record<string, string | undefined> = process.env,
  options: ResolveOptions = {},
): CemsCredentials | undefined => {
  const apiUrl = (env.CEMS_API_URL?.trim() || DEFAULT_CEMS_API_URL).replace(/\/$/, '')

  const fromEnv = env.CEMS_API_KEY?.trim()
  if (fromEnv) return { apiUrl, key: fromEnv, keySource: 'CEMS_API_KEY' }

  const rcPaths = options.rcPaths ?? [
    join(process.cwd(), '.env'),
    join(process.cwd(), '.cdsapirc'),
    join(homedir(), '.cdsapirc'),
  ]

  for (const path of rcPaths) {
    const text = readIfPresent(path)
    if (text === undefined) continue
    const key = parseCdsApiRc(text).key
    if (key) return { apiUrl, key, keySource: path }
  }

  return undefined
}

/**
 * Said once at startup rather than as a 502 per request, in the same spirit as the routing key
 * warning: a store URL pointing at the Climate Data Store is the mistake this is most likely to
 * be, and it fails as a 404 on the dataset rather than as anything mentioning the URL.
 */
export const describeCemsConfig = (credentials: CemsCredentials | undefined): string | null => {
  if (credentials === undefined) {
    return (
      'No Copernicus data-store token found; the European flood forecast will report itself as ' +
      'unconfigured. Set CEMS_API_KEY, or keep a `key:` line in .env or ~/.cdsapirc. Get a token ' +
      'at https://ewds.climate.copernicus.eu/profile'
    )
  }
  if (credentials.apiUrl.includes('cds.climate.copernicus.eu')) {
    return (
      `CEMS_API_URL points at ${credentials.apiUrl}, which is the Climate Data Store; CEMS-Flood ` +
      `moved to the ECMWF Data Store and cems-glofas-forecast is not in that catalogue. Use ` +
      `${DEFAULT_CEMS_API_URL}`
    )
  }
  return null
}
