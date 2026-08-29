import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, parseConfig, toSearch } from './config'

describe('parseConfig', () => {
  it('falls back to defaults for an empty query', () => {
    expect(parseConfig('')).toEqual(DEFAULT_CONFIG)
  })

  it('reads a tool set list', () => {
    expect(parseConfig('?toolSets=todo,forms').toolSets).toEqual(['todo', 'forms'])
  })

  it('treats an empty toolSets value as an explicit empty selection', () => {
    expect(parseConfig('?toolSets=').toolSets).toEqual([])
  })

  it('accepts a known adapter override and ignores an unknown one', () => {
    expect(parseConfig('?adapter=in-memory').adapter).toBe('in-memory')
    expect(parseConfig('?adapter=nonsense').adapter).toBeUndefined()
  })

  it('ignores non-positive numbers rather than half-applying them', () => {
    expect(parseConfig('?maxSteps=0').maxSteps).toBe(DEFAULT_CONFIG.maxSteps)
    expect(parseConfig('?maxSteps=-3').maxSteps).toBe(DEFAULT_CONFIG.maxSteps)
    expect(parseConfig('?maxSteps=abc').maxSteps).toBe(DEFAULT_CONFIG.maxSteps)
    expect(parseConfig('?maxSteps=20').maxSteps).toBe(20)
  })
})

describe('toSearch', () => {
  it('emits nothing when everything is default', () => {
    expect(toSearch(DEFAULT_CONFIG)).toBe('')
  })

  it('round-trips a non-default configuration', () => {
    const config = {
      ...DEFAULT_CONFIG,
      toolSets: ['forms'],
      adapter: 'in-memory' as const,
      driver: 'scripted' as const,
      strategy: 'prompted' as const,
      maxSteps: 3,
    }
    expect(parseConfig(toSearch(config))).toEqual(config)
  })
})
