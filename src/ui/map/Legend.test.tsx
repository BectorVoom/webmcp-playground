import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Legend } from './Legend'
import { HAZARD_PALETTE } from '../../lib/hazard-palette'

/**
 * A legend that does not describe the map is worse than no legend: it tells a reader that the dark
 * patch under their street means something other than what it means. The map painted `extreme` a
 * dark maroon while this component showed purple, and `low` green while it showed pale yellow — and
 * the mismatch only surfaced when the GSI depth legend was corrected and `extreme` began to appear.
 */
describe('Legend (R5.7)', () => {
  it('shows a swatch for every hazard class the map can paint', () => {
    render(<Legend />)

    for (const entry of HAZARD_PALETTE) {
      expect(screen.getByTestId(`legend-hazard-${entry.hazardClass}`)).toBeInTheDocument()
    }
  })

  it('paints each swatch the colour the map paints that class', () => {
    render(<Legend />)

    for (const entry of HAZARD_PALETTE) {
      const swatch = screen.getByTestId(`legend-hazard-${entry.hazardClass}`).querySelector('span')
      expect(swatch).toBeTruthy()
      expect(swatch).toHaveStyle({ backgroundColor: entry.fill })
    }
  })

  it('names the depth band beside each swatch', () => {
    render(<Legend />)

    expect(screen.getByText(/Extreme \(5\.0 m and deeper\)/)).toBeInTheDocument()
    expect(screen.getByText(/High \(3\.0 – 5\.0 m\)/)).toBeInTheDocument()
    expect(screen.getByText(/Moderate \(0\.5 – 3\.0 m\)/)).toBeInTheDocument()
    expect(screen.getByText(/Low \(below 0\.5 m\)/)).toBeInTheDocument()
  })

  it('explains the grey that mapped-but-unreadable inundation is drawn in', () => {
    render(<Legend />)

    // Without this entry a grey patch reads as a rendering fault rather than as real inundation
    // whose depth the authority published in a colour outside its own legend.
    expect(screen.getByText(/Depth unreadable/)).toBeInTheDocument()
  })
})
