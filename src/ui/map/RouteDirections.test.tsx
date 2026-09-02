import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FeatureCollection } from 'geojson'
import { RouteDirections } from './RouteDirections'
import { formatDistance, formatDuration } from './format'
import type { MapLayerData } from '../../ports/Map'
import type { RouteStep } from '../../domain/routing'

/**
 * A drawn line says roughly where to go. Turn-by-turn says what to do next, which is the part that
 * matters when the point of the feature is leaving somewhere quickly. These render the panel the
 * way a reader meets it and assert what they can actually see: the manoeuvre, the distance to it,
 * how far they have come, and whether the route is safe to take.
 */

const NORTH = '指定緊急避難場所 (北部地区センター)'

const steps: ReadonlyArray<RouteStep> = [
  {
    instruction: 'Head N for 433 m.',
    metres: 433,
    seconds: 361,
    maneuver: 'depart',
    at: { longitude: 139.4637, latitude: 35.5677 },
  },
  {
    instruction: 'Turn right and continue for 217 m.',
    metres: 217,
    seconds: 181,
    maneuver: 'right',
    streetNames: ['Marunouchi Street'],
    at: { longitude: 139.4637, latitude: 35.5716 },
  },
  {
    instruction: 'Turn left and continue for 240 m.',
    metres: 240,
    seconds: 200,
    maneuver: 'left',
    at: { longitude: 139.4661, latitude: 35.5716 },
  },
  {
    instruction: `Arrive at ${NORTH}.`,
    metres: 0,
    seconds: 0,
    maneuver: 'arrive',
    at: { longitude: 139.4667, latitude: 35.5737 },
  },
]

const routeFeature = (overrides: Record<string, unknown> = {}) => ({
  type: 'Feature' as const,
  geometry: {
    type: 'LineString' as const,
    coordinates: [
      [139.4637, 35.5677],
      [139.4637, 35.5716],
      [139.4661, 35.5716],
      [139.4667, 35.5737],
    ],
  },
  properties: {
    rank: 1,
    destination: NORTH,
    destinationRisk: 'clear',
    metres: 890,
    seconds: 742,
    costing: 'pedestrian',
    exclusions: 'not_requested',
    crossings: 0,
    crossingsAssessed: true,
    simulated: true,
    steps,
    ...overrides,
  },
})

const routesLayer = (
  features: ReadonlyArray<ReturnType<typeof routeFeature>>,
  visible = true,
): MapLayerData => ({
  id: 'routes',
  visible,
  geojson: { type: 'FeatureCollection', features: [...features] } as FeatureCollection,
  featureCount: features.length,
  vertexCount: features.length * 4,
  attributions: ['Simulated Routing Engine'],
  updatedAt: Date.now(),
})

describe('RouteDirections', () => {
  it('renders nothing when no route has been planned', () => {
    const { container } = render(<RouteDirections layers={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing while the routes layer is toggled off', () => {
    const { container } = render(<RouteDirections layers={[routesLayer([routeFeature()], false)]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('heads the panel with the destination, distance, time and travel mode', () => {
    render(<RouteDirections layers={[routesLayer([routeFeature()])]} />)

    expect(screen.getByTestId('route-destination')).toHaveTextContent(NORTH)
    expect(screen.getByTestId('route-summary')).toHaveTextContent('890 m')
    expect(screen.getByTestId('route-summary')).toHaveTextContent('12 min')
    expect(screen.getByTestId('route-summary')).toHaveTextContent('pedestrian')
    expect(screen.getByTestId('route-risk-badge')).toHaveTextContent('Clear')
  })

  it('lists every manoeuvre in order with its own distance', () => {
    render(<RouteDirections layers={[routesLayer([routeFeature()])]} />)

    const list = within(screen.getByTestId('route-steps')).getAllByRole('listitem')
    expect(list).toHaveLength(4)
    expect(list[0]).toHaveTextContent('Head N for 433 m.')
    expect(list[0]).toHaveTextContent('433 m')
    expect(list[1]).toHaveTextContent('Turn right and continue for 217 m.')
    expect(list[3]).toHaveTextContent(`Arrive at ${NORTH}.`)
  })

  it('gives each step an arrow a screen reader can name', () => {
    render(<RouteDirections layers={[routesLayer([routeFeature()])]} />)

    const icons = screen.getAllByRole('img')
    expect(icons.map((i) => i.getAttribute('aria-label'))).toEqual([
      'Depart',
      'Turn right',
      'Turn left',
      'Arrive',
    ])
    // Left and right must be mirrored, not the same glyph twice.
    expect(icons[1]).toHaveStyle({ transform: 'rotate(90deg)' })
    expect(icons[2]).toHaveStyle({ transform: 'rotate(-90deg)' })
  })

  it('falls back to a straight-on arrow for a step the engine did not classify', () => {
    const unclassified = [{ instruction: 'Continue.', metres: 100, seconds: 80 }]
    render(<RouteDirections layers={[routesLayer([routeFeature({ steps: unclassified })])]} />)

    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Continue straight')
  })

  it('shows how far the reader has come at each step', () => {
    render(<RouteDirections layers={[routesLayer([routeFeature()])]} />)

    expect(screen.getByTestId('route-step-0')).toHaveTextContent('0 m in')
    expect(screen.getByTestId('route-step-1')).toHaveTextContent('433 m in')
    expect(screen.getByTestId('route-step-2')).toHaveTextContent('650 m in')
    expect(screen.getByTestId('route-step-3')).toHaveTextContent('890 m in')
  })

  it('names the street where the engine supplied one', () => {
    render(<RouteDirections layers={[routesLayer([routeFeature()])]} />)
    expect(screen.getByTestId('route-step-1')).toHaveTextContent('Marunouchi Street')
  })

  it('brings the map to a step when it is picked', async () => {
    const onFocusStep = vi.fn()
    render(<RouteDirections layers={[routesLayer([routeFeature()])]} onFocusStep={onFocusStep} />)

    await userEvent.click(within(screen.getByTestId('route-step-1')).getByRole('button'))

    expect(onFocusStep).toHaveBeenCalledWith({ longitude: 139.4637, latitude: 35.5716 })
  })

  it('leaves steps unclickable when there is no map to move', () => {
    render(<RouteDirections layers={[routesLayer([routeFeature()])]} />)
    expect(within(screen.getByTestId('route-steps')).queryByRole('button')).toBeNull()
  })

  it('hides and restores the steps without losing the summary', async () => {
    render(<RouteDirections layers={[routesLayer([routeFeature()])]} />)

    await userEvent.click(screen.getByTestId('route-directions-toggle'))
    expect(screen.queryByTestId('route-steps')).toBeNull()
    expect(screen.getByTestId('route-summary')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('route-directions-toggle'))
    expect(screen.getByTestId('route-steps')).toBeInTheDocument()
  })

  describe('when several routes were planned', () => {
    const layer = routesLayer([
      routeFeature(),
      routeFeature({
        rank: 2,
        destination: '指定避難所 (東部コミュニティスクール)',
        destinationRisk: 'at_risk',
        metres: 1290,
        seconds: 1075,
        steps: [
          { instruction: 'Head E for 1290 m.', metres: 1290, seconds: 1075, maneuver: 'depart' },
        ],
      }),
    ])

    it('offers each one and shows the first by default', () => {
      render(<RouteDirections layers={[layer]} />)

      expect(screen.getByTestId('route-option-1')).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByTestId('route-option-2')).toHaveTextContent('1.3 km')
      expect(screen.getByTestId('route-destination')).toHaveTextContent(NORTH)
    })

    it('switches the steps and the header when another is chosen', async () => {
      render(<RouteDirections layers={[layer]} />)

      await userEvent.click(screen.getByTestId('route-option-2'))

      expect(screen.getByTestId('route-destination')).toHaveTextContent('東部コミュニティスクール')
      expect(screen.getByTestId('route-risk-badge')).toHaveTextContent('At risk')
      expect(within(screen.getByTestId('route-steps')).getAllByRole('listitem')).toHaveLength(1)
    })

    it('tells the map which route to highlight when one is picked', async () => {
      const onSelectRoute = vi.fn()
      render(<RouteDirections layers={[layer]} onSelectRoute={onSelectRoute} />)

      await userEvent.click(screen.getByTestId('route-option-2'))
      expect(onSelectRoute).toHaveBeenCalledWith(2)

      await userEvent.click(screen.getByTestId('route-option-1'))
      expect(onSelectRoute).toHaveBeenLastCalledWith(1)
    })

    it('says which option is the safest, for a reader who cannot see the colours', () => {
      render(<RouteDirections layers={[layer]} />)

      const options = screen.getByTestId('route-options')
      expect(options).toHaveTextContent('safest first')
      expect(options).toHaveTextContent('Route 1 is the recommendation')
      // The badge sits on the leader alone, so "safest" is never ambiguous.
      expect(within(options).getAllByTestId('route-option-safest')).toHaveLength(1)
      expect(screen.getByTestId('route-option-1')).toHaveTextContent('safest')
    })

    it('says why each option is ranked where it is, not just how long it is', () => {
      render(<RouteDirections layers={[layer]} />)

      // Distance alone cannot explain an order that puts a longer route first.
      expect(screen.getByTestId('route-option-1')).toHaveTextContent(/clear of flooding|in water/)
      expect(screen.getByTestId('route-option-2')).toHaveAccessibleName(/Route 2 to /)
    })

    it('falls back to the first route when a new plan replaces the chosen one', async () => {
      const { rerender } = render(<RouteDirections layers={[layer]} />)
      await userEvent.click(screen.getByTestId('route-option-2'))
      expect(screen.getByTestId('route-destination')).toHaveTextContent('東部コミュニティスクール')

      // A fresh plan to somewhere else entirely — the stale selection must not survive it.
      rerender(
        <RouteDirections
          layers={[routesLayer([routeFeature({ destination: '広域避難拠点 (南部防災交流館)' })])]}
        />,
      )

      expect(screen.getByTestId('route-destination')).toHaveTextContent('南部防災交流館')
      expect(screen.queryByTestId('route-options')).toBeNull()
    })
  })

  describe('flood safety of the route', () => {
    it('warns when exclusions could not be applied', () => {
      render(
        <RouteDirections layers={[routesLayer([routeFeature({ exclusions: 'unavoided' })])]} />,
      )
      expect(screen.getByTestId('route-flood-warning')).toHaveTextContent(
        /may cross a flood zone/i,
      )
      expect(screen.getByTestId('route-flood-warning')).toHaveAttribute('role', 'alert')
    })

    it('counts the crossings when the route does cross', () => {
      render(<RouteDirections layers={[routesLayer([routeFeature({ crossings: 2 })])]} />)
      expect(screen.getByTestId('route-flood-warning')).toHaveTextContent('Crosses a flood zone 2 times')
    })

    it('stays quiet when the route is clear', () => {
      render(<RouteDirections layers={[routesLayer([routeFeature()])]} />)
      expect(screen.queryByTestId('route-flood-warning')).toBeNull()
    })

    it('never presents simulated guidance as real navigation', () => {
      render(<RouteDirections layers={[routesLayer([routeFeature()])]} />)
      expect(screen.getByTestId('route-directions')).toHaveTextContent(
        /Simulated route — not for real-world emergency navigation/i,
      )
      expect(screen.getByTestId('route-directions')).toHaveTextContent(/Decision support only/i)
    })
  })
})

describe('distance and duration wording', () => {
  it.each([
    [0, '0 m'],
    [217, '217 m'],
    [999, '999 m'],
    [1000, '1.0 km'],
    [1290, '1.3 km'],
    [12_400, '12 km'],
  ])('renders %i m as %s', (metres, expected) => {
    expect(formatDistance(metres)).toBe(expected)
  })

  it.each([
    [0, 'under a minute'],
    [29, 'under a minute'],
    [742, '12 min'],
    [3600, '1 h'],
    [3900, '1 h 5 min'],
  ])('renders %i s as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected)
  })
})
