import { describe, expect, it } from 'vitest'
import {
  HAZARD_PALETTE,
  hazardFill,
  hazardLine,
  hazardMatchExpression,
} from './hazard-palette'
import type { HazardClass } from '../domain/hazard'

/**
 * Every hazard class a zone can carry must have a colour here, because this table is now the only
 * place that decides one. A class missing from it would be painted the fallback grey on the map and
 * would vanish from the legend — which is precisely the shape of the bug this table replaced.
 */
const ALL_CLASSES: ReadonlyArray<HazardClass> = [
  'low',
  'moderate',
  'high',
  'extreme',
  'unclassified',
]

describe('HAZARD_PALETTE', () => {
  it('covers every hazard class exactly once', () => {
    const classes = HAZARD_PALETTE.map((e) => e.hazardClass)
    expect(new Set(classes).size).toBe(classes.length)
    for (const hazardClass of ALL_CLASSES) {
      expect(classes).toContain(hazardClass)
    }
    expect(classes).toHaveLength(ALL_CLASSES.length)
  })

  it('gives every class a distinct fill, so two depths never look the same', () => {
    const fills = HAZARD_PALETTE.map((e) => e.fill)
    expect(new Set(fills).size).toBe(fills.length)
  })

  it('names the depth band each class covers', () => {
    for (const entry of HAZARD_PALETTE) {
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.depthLabel.length).toBeGreaterThan(0)
      expect(entry.fill).toMatch(/^#[0-9a-f]{6}$/i)
      expect(entry.line).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('reads back the colour for a class, and greys anything it does not know', () => {
    expect(hazardFill('extreme')).toBe('#800026')
    expect(hazardLine('extreme')).toBe('#4a0014')
    expect(hazardFill('unclassified')).toBe('#64748b')
    expect(hazardFill('nonsense' as HazardClass)).toBe(hazardFill('unclassified'))
  })
})

describe('hazardMatchExpression', () => {
  it('builds a MapLibre match over every class, with a fallback', () => {
    const expression = hazardMatchExpression('fill')

    expect(expression[0]).toBe('match')
    expect(expression[1]).toEqual(['get', 'hazardClass'])
    // 'match', input, then a class/colour pair each, then the fallback.
    expect(expression).toHaveLength(2 + HAZARD_PALETTE.length * 2 + 1)
    expect(expression.at(-1)).toBe(hazardFill('unclassified'))

    for (const entry of HAZARD_PALETTE) {
      const at = expression.indexOf(entry.hazardClass)
      expect(at).toBeGreaterThan(1)
      expect(expression[at + 1]).toBe(entry.fill)
    }
  })

  it('builds the outline expression from the same table', () => {
    const expression = hazardMatchExpression('line')
    for (const entry of HAZARD_PALETTE) {
      expect(expression[expression.indexOf(entry.hazardClass) + 1]).toBe(entry.line)
    }
  })
})
