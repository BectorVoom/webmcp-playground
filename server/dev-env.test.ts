import { describe, expect, it } from 'vitest'
import { applyEnvFile } from './dev-env'

/**
 * `bun run dev` loads `.env` into Bun's own process and spawns Vite as a child, which inherits
 * none of it — so the backend running inside the dev server saw no configuration at all, and a
 * missing routing key surfaced as a 401 per request rather than as a missing key. `vite.config.ts`
 * reads the file itself; this is the rule it applies.
 */
describe('handing .env to the backend inside the dev server', () => {
  it('fills in variables the process does not already have', () => {
    const env: Record<string, string | undefined> = {}
    applyEnvFile({ ROUTING_API_KEY: 'from-file', GEO_DATA_MODE: 'live' }, env)

    expect(env.ROUTING_API_KEY).toBe('from-file')
    expect(env.GEO_DATA_MODE).toBe('live')
  })

  it('lets a real environment variable win, so a command-line override still works', () => {
    const env: Record<string, string | undefined> = { GEO_DATA_MODE: 'live' }
    applyEnvFile({ GEO_DATA_MODE: 'fixture' }, env)

    expect(env.GEO_DATA_MODE).toBe('live')
  })

  it('fills an explicitly empty variable, which the config layer reads as unset anyway', () => {
    const env: Record<string, string | undefined> = { ROUTING_API_KEY: undefined }
    applyEnvFile({ ROUTING_API_KEY: 'from-file' }, env)

    expect(env.ROUTING_API_KEY).toBe('from-file')
  })

  it('leaves everything else alone', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    applyEnvFile({}, env)

    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})
