import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'

/**
 * Tasks 0.3: the architectural seam rules are enforced by tooling, and
 * that enforcement is itself tested. A seam maintained by convention erodes on
 * the first deadline; a seam with a failing build does not.
 *
 * `lintText` is given a path rather than a real file, so the fixtures cannot
 * rot and cannot themselves fail `eslint .`.
 */
const lint = async (filePath: string, code: string) => {
  const eslint = new ESLint({ cwd: process.cwd() })
  const [result] = await eslint.lintText(code, { filePath })
  return result?.messages ?? []
}

describe('WebMCP host globals are confined to the adapter directory (R6.1)', () => {
  it('rejects document.modelContext outside src/adapters/webmcp/', async () => {
    const messages = await lint(
      'src/app/sneaky.ts',
      'export const tools = () => document.modelContext?.getTools()\n',
    )
    expect(messages.map((m) => m.message).join('\n')).toContain(
      'document.modelContext may only be used in src/adapters/webmcp/',
    )
  })

  it('rejects navigator.modelContext outside src/adapters/webmcp/', async () => {
    const messages = await lint(
      'src/ui/sneaky.ts',
      'export const ctx = navigator.modelContext\n',
    )
    expect(messages.some((m) => m.message.includes('navigator.modelContext'))).toBe(true)
  })

  it('allows both inside src/adapters/webmcp/', async () => {
    const messages = await lint(
      'src/adapters/webmcp/probe.ts',
      'export const a = document.modelContext\nexport const b = navigator.modelContext\n',
    )
    expect(messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(0)
  })
})

describe('MapLibre GL is confined to src/adapters/map/ (R6.1)', () => {
  it('rejects maplibre-gl outside src/adapters/map/', async () => {
    const messages = await lint(
      'src/ui/map-pane.ts',
      "import maplibregl from 'maplibre-gl'\nexport const map = maplibregl\n",
    )
    expect(messages.map((m) => m.message).join('\n')).toContain(
      'maplibre-gl may only be imported in src/adapters/map/**',
    )
  })

  it('allows maplibre-gl inside src/adapters/map/', async () => {
    const messages = await lint(
      'src/adapters/map/maplibre.ts',
      "import maplibregl from 'maplibre-gl'\nexport const map = maplibregl\n",
    )
    expect(messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(0)
  })
})

describe('@turf/* is confined to src/lib/geometry/ (R6.1)', () => {
  it('rejects @turf/* outside src/lib/geometry/', async () => {
    const messages = await lint(
      'src/adapters/geo/us/flood.ts',
      "import circle from '@turf/circle'\nexport const c = circle\n",
    )
    expect(messages.map((m) => m.message).join('\n')).toContain(
      '@turf/* may only be imported in src/lib/geometry/**',
    )
  })

  it('allows @turf/* inside src/lib/geometry/', async () => {
    const messages = await lint(
      'src/lib/geometry/circle.ts',
      "import circle from '@turf/circle'\nexport const c = circle\n",
    )
    expect(messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(0)
  })
})

describe('Upstream host literals are confined to src/adapters/geo/ (R6.1)', () => {
  it('rejects upstream host literals outside src/adapters/geo/', async () => {
    const messages = await lint(
      'src/domain/hazard.ts',
      "export const URL = 'https://api.weather.gov/alerts'\n",
    )
    expect(messages.map((m) => m.message).join('\n')).toContain(
      'Upstream host literals may only be used in src/adapters/geo/**',
    )
  })

  it('allows upstream host literals inside src/adapters/geo/', async () => {
    const messages = await lint(
      'src/adapters/geo/us/alerts.ts',
      "export const URL = 'https://api.weather.gov/alerts'\n",
    )
    expect(messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(0)
  })
})

describe('control flow stays in the typed error channel (R7.1)', () => {
  it('rejects throw in the domain, ports and app layers', async () => {
    for (const path of ['src/domain/x.ts', 'src/ports/x.ts', 'src/app/x.ts']) {
      const messages = await lint(path, 'export const f = () => { throw new Error("no") }\n')
      expect(messages.map((m) => m.message).join('\n')).toContain(
        'Use a tagged error in the Effect error channel instead of throw',
      )
    }
  })

  it('allows throw at an adapter or UI boundary, where the platform throws anyway', async () => {
    const messages = await lint(
      'src/adapters/webmcp/x.ts',
      'export const f = () => { throw new Error("host boundary") }\n',
    )
    expect(messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(0)
  })
})
