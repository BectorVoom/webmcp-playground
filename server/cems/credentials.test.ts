import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CEMS_API_URL,
  describeCemsConfig,
  parseCdsApiRc,
  resolveCemsCredentials,
} from './credentials'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cdsrc-test-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const writeRc = (name: string, contents: string): string => {
  const path = join(directory, name)
  writeFileSync(path, contents)
  return path
}

describe('parseCdsApiRc', () => {
  /**
   * The exact shape Copernicus's own instructions tell you to paste. A `.env` loader reads
   * `NAME=value` lines and skips these silently, which is why they are parsed deliberately.
   */
  it('reads the two-line .cdsapirc block', () => {
    const parsed = parseCdsApiRc(
      'url: https://cds.climate.copernicus.eu/api\nkey: 01234567-89ab-cdef-0123-456789abcdef\n',
    )
    expect(parsed.url).toBe('https://cds.climate.copernicus.eu/api')
    expect(parsed.key).toBe('01234567-89ab-cdef-0123-456789abcdef')
  })

  /** The pre-2024 store issued `<uid>:<key>`; the current one rejects the prefix. */
  it('strips a legacy uid prefix', () => {
    expect(parseCdsApiRc('key: 12345:01234567-89ab-cdef-0123-456789abcdef').key).toBe(
      '01234567-89ab-cdef-0123-456789abcdef',
    )
  })

  it('ignores the dotenv lines around it', () => {
    const parsed = parseCdsApiRc('PORT=8787\nROUTING_API_KEY=abc\n\n# CDS API key\nkey: token-here\n')
    expect(parsed.key).toBe('token-here')
  })

  it('finds nothing in a file that has nothing', () => {
    expect(parseCdsApiRc('PORT=8787\nLLM_API_KEY=\n')).toEqual({})
  })

  it('does not mistake a dotenv variable ending in "key" for the block', () => {
    expect(parseCdsApiRc('ROUTING_API_KEY=abc\nMAP_TILE_KEY=def\n').key).toBeUndefined()
  })
})

describe('resolveCemsCredentials', () => {
  it('defaults to the ECMWF Data Store, which is where the flood data lives', () => {
    const resolved = resolveCemsCredentials({ CEMS_API_KEY: 'token' }, { rcPaths: [] })
    expect(resolved?.apiUrl).toBe(DEFAULT_CEMS_API_URL)
    expect(resolved?.key).toBe('token')
  })

  /** An explicit variable is what somebody reaches for to override a file; it has to win. */
  it('prefers the environment variable over a file', () => {
    const path = writeRc('.env', 'key: from-file')
    const resolved = resolveCemsCredentials({ CEMS_API_KEY: 'from-env' }, { rcPaths: [path] })
    expect(resolved?.key).toBe('from-env')
    expect(resolved?.keySource).toBe('CEMS_API_KEY')
  })

  it('falls back to the first file that carries a key, and says which', () => {
    const empty = writeRc('.env', 'PORT=8787')
    const rc = writeRc('.cdsapirc', 'url: https://cds.climate.copernicus.eu/api\nkey: from-rc')
    const resolved = resolveCemsCredentials({}, { rcPaths: [empty, rc] })

    expect(resolved?.key).toBe('from-rc')
    expect(resolved?.keySource).toBe(rc)
  })

  it('skips files that are not there', () => {
    const rc = writeRc('.cdsapirc', 'key: from-rc')
    expect(resolveCemsCredentials({}, { rcPaths: [join(directory, 'nope'), rc] })?.key).toBe('from-rc')
  })

  /** No token is an ordinary configuration, not an error: the forecast reports itself unconfigured. */
  it('returns nothing rather than throwing when there is no key anywhere', () => {
    expect(resolveCemsCredentials({}, { rcPaths: [] })).toBeUndefined()
  })

  it('honours an explicit store URL and trims its trailing slash', () => {
    const resolved = resolveCemsCredentials(
      { CEMS_API_KEY: 'token', CEMS_API_URL: 'https://example.invalid/api/' },
      { rcPaths: [] },
    )
    expect(resolved?.apiUrl).toBe('https://example.invalid/api')
  })
})

describe('describeCemsConfig', () => {
  it('says how to configure a missing token', () => {
    const warning = describeCemsConfig(undefined)
    expect(warning).toContain('CEMS_API_KEY')
    expect(warning).toContain('ewds.climate.copernicus.eu')
  })

  /**
   * The likeliest misconfiguration, because the `url:` line Copernicus tells you to paste points
   * at the Climate Data Store — where the flood datasets are not. It fails as a 404 on the
   * dataset, which says nothing about the URL being wrong.
   */
  it('catches a store URL pointing at the Climate Data Store', () => {
    const warning = describeCemsConfig({
      apiUrl: 'https://cds.climate.copernicus.eu/api',
      key: 'token',
      keySource: 'test',
    })
    expect(warning).toContain('Climate Data Store')
    expect(warning).toContain(DEFAULT_CEMS_API_URL)
  })

  it('says nothing when the configuration is right', () => {
    expect(
      describeCemsConfig({ apiUrl: DEFAULT_CEMS_API_URL, key: 'token', keySource: 'test' }),
    ).toBeNull()
  })
})
