import { describe, expect, it } from 'vitest'
import { detectAdapter } from './detect'

describe('detectAdapter', () => {
  it('falls back to the in-memory host where WebMCP is absent', () => {
    const { entry, report } = detectAdapter()
    expect(entry.id).toBe('in-memory')
    expect(report.selected).toBe('in-memory')
    expect(report.overridden).toBe(false)
  })

  it('records a reason for every candidate, including the rejected ones', () => {
    const { report } = detectAdapter()
    expect(report.candidates).toHaveLength(3)
    for (const candidate of report.candidates) {
      expect(candidate.reason.length).toBeGreaterThan(0)
    }
  })

  it('distinguishes "no WebMCP" from "WebMCP without registerTool"', () => {
    const absent = detectAdapter().report.candidates.find((c) => c.id === 'draft-2026-04')
    expect(absent?.reason).toContain('not implemented')

    Object.defineProperty(document, 'modelContext', {
      value: { getTools: () => [] },
      configurable: true,
    })
    const partial = detectAdapter().report.candidates.find((c) => c.id === 'draft-2026-04')
    expect(partial?.reason).toContain('no registerTool')
    expect(partial?.reason).toContain('draft has probably moved')

    Reflect.deleteProperty(document, 'modelContext')
  })

  it('honours an explicit override and says that it did', () => {
    const { entry, report } = detectAdapter('legacy-navigator')
    expect(entry.id).toBe('legacy-navigator')
    expect(report.overridden).toBe(true)
  })
})
