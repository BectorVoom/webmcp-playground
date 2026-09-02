import React, { useMemo, useState } from 'react'
import type { Feature } from 'geojson'
import type { LonLat } from '../../domain/geo'
import type { RouteManeuver, RouteStep } from '../../domain/routing'
import type { MapLayerData } from '../../ports/Map'
import { formatDistance, formatDuration } from './format'

export interface RouteDirectionsProps {
  readonly layers: ReadonlyArray<MapLayerData>
  /** Called with the point a step begins at, so the map can be brought to it. */
  readonly onFocusStep?: (at: LonLat) => void
  /** Called with the rank of the route the reader picked, so the map can highlight that one. */
  readonly onSelectRoute?: (rank: number) => void
}

interface RouteView {
  readonly key: string
  readonly rank: number
  readonly destination: string
  readonly destinationRisk: string
  readonly metres: number
  readonly seconds: number
  readonly costing: string
  readonly exclusions: string
  readonly crossings: number
  readonly crossingsAssessed: boolean
  /** Metres of the path that run through flood water; what decides which candidate leads. */
  readonly exposedMetres: number
  readonly simulated: boolean
  readonly steps: ReadonlyArray<RouteStep>
}

const MANEUVER_LABEL: Record<RouteManeuver, string> = {
  depart: 'Depart',
  straight: 'Continue straight',
  'slight-left': 'Bear left',
  left: 'Turn left',
  'sharp-left': 'Sharp left',
  'slight-right': 'Bear right',
  right: 'Turn right',
  'sharp-right': 'Sharp right',
  uturn: 'U-turn',
  arrive: 'Arrive',
}

/**
 * Rotation of a north-pointing arrow, in degrees. A single glyph turned to match the manoeuvre
 * reads faster than ten unrelated icons, and keeps left and right unmistakably mirrored.
 */
const MANEUVER_ROTATION: Record<RouteManeuver, number> = {
  depart: 0,
  straight: 0,
  'slight-left': -45,
  left: -90,
  'sharp-left': -135,
  'slight-right': 45,
  right: 90,
  'sharp-right': 135,
  uturn: 180,
  arrive: 0,
}

const ManeuverIcon: React.FC<{ maneuver: RouteManeuver }> = ({ maneuver }) => {
  const label = MANEUVER_LABEL[maneuver]
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    role: 'img' as const,
    'aria-label': label,
    'data-maneuver': maneuver,
  }

  if (maneuver === 'arrive') {
    return (
      <svg {...common}>
        <circle cx="12" cy="10" r="3" />
        <path d="M12 21c-4-5-7-8.1-7-11a7 7 0 0 1 14 0c0 2.9-3 6-7 11z" />
      </svg>
    )
  }

  return (
    <svg {...common} style={{ transform: `rotate(${MANEUVER_ROTATION[maneuver]}deg)` }}>
      <path d="M12 20V5" />
      <path d="M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  )
}

const RISK_BADGE: Record<string, { label: string; className: string }> = {
  clear: { label: 'Clear', className: 'bg-emerald-900/70 text-emerald-200 border-emerald-700' },
  at_risk: { label: 'At risk', className: 'bg-red-900/70 text-red-200 border-red-700' },
  unknown: { label: 'Risk unknown', className: 'bg-amber-900/70 text-amber-200 border-amber-700' },
}

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const asSteps = (value: unknown): ReadonlyArray<RouteStep> =>
  Array.isArray(value)
    ? value.filter((step): step is RouteStep => typeof step === 'object' && step !== null)
    : []

const toRouteView = (feature: Feature, index: number): RouteView => {
  const p = feature.properties ?? {}
  return {
    key: `${asNumber(p.rank, index + 1)}-${asString(p.destination, String(index))}`,
    rank: asNumber(p.rank, index + 1),
    destination: asString(p.destination, 'Destination'),
    destinationRisk: asString(p.destinationRisk, 'unknown'),
    metres: asNumber(p.metres),
    seconds: asNumber(p.seconds),
    costing: asString(p.costing, 'pedestrian'),
    exclusions: asString(p.exclusions, 'not_requested'),
    crossings: asNumber(p.crossings),
    crossingsAssessed: p.crossingsAssessed !== false,
    exposedMetres: asNumber(p.exposedMetres),
    simulated: p.simulated === true,
    steps: asSteps(p.steps),
  }
}

/**
 * Turn-by-turn guidance for the planned evacuation routes (R3.7, R5.8).
 *
 * The route line alone tells a reader roughly where to go, which is not enough when the point of
 * the feature is leaving somewhere quickly. This lists the manoeuvres the way a navigation app
 * does — arrow, instruction, distance to the next one, distance covered so far — and lets a step
 * be selected to bring the map to it.
 *
 * It reads the `routes` map layer rather than holding its own copy, so the directions and the line
 * on the map can never describe different routes.
 */
export const RouteDirections: React.FC<RouteDirectionsProps> = ({
  layers,
  onFocusStep,
  onSelectRoute,
}) => {
  const routes = useMemo<ReadonlyArray<RouteView>>(() => {
    const layer = layers.find((l) => l.id === 'routes')
    if (!layer || !layer.visible) return []
    return layer.geojson.features.map(toRouteView)
  }, [layers])

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  // Derived, not synchronised: a new plan replaces the old one, and a key left over from the
  // previous plan simply falls back to the first route rather than showing directions for a
  // route that is no longer on the map.
  const selected = routes.find((r) => r.key === selectedKey) ?? routes[0]

  // Distance covered before each step. Written as a scan rather than a running total so the
  // render stays free of mutation; a route has a handful of steps, never enough for it to matter.
  const distanceIn = useMemo(() => {
    const steps = selected?.steps ?? []
    return steps.map((_, index) =>
      steps.slice(0, index).reduce((sum, step) => sum + step.metres, 0),
    )
  }, [selected])

  if (routes.length === 0 || selected === undefined) return null
  const risk = RISK_BADGE[selected.destinationRisk] ?? RISK_BADGE.unknown!
  const unavoided = selected.exclusions === 'unavoided'
  const crossesFlood = selected.crossingsAssessed && selected.crossings > 0

  return (
    <section
      data-testid="route-directions"
      aria-label="Turn-by-turn directions"
      className="border-t border-slate-800 bg-slate-900/80 text-slate-200 flex flex-col min-h-0"
    >
      <header className="flex items-start justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-ui font-semibold uppercase tracking-wider text-slate-400">
              Directions
            </span>
            <span
              className={`text-meta px-1.5 py-0.5 rounded border ${risk.className}`}
              data-testid="route-risk-badge"
            >
              {risk.label}
            </span>
          </div>
          <div
            className="text-body font-medium text-slate-100 truncate"
            title={selected.destination}
            data-testid="route-destination"
          >
            {selected.destination}
          </div>
          <div className="text-ui text-slate-400" data-testid="route-summary">
            {formatDistance(selected.metres)} · {formatDuration(selected.seconds)} ·{' '}
            {selected.costing}
          </div>
        </div>
        <button
          type="button"
          data-testid="route-directions-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
          className="shrink-0 px-2 py-1 text-ui bg-slate-800 hover:bg-slate-700 rounded border border-slate-700 cursor-pointer"
        >
          {collapsed ? 'Show steps' : 'Hide steps'}
        </button>
      </header>

      {routes.length > 1 && (
        <div className="px-3 pb-2 flex gap-1.5 flex-wrap" data-testid="route-options">
          <span className="sr-only">
            {routes.length} route candidates, safest first. Route 1 is the recommendation; picking
            another highlights it on the map.
          </span>
          {routes.map((route) => {
            const active = route.key === selected.key
            const wet = route.crossingsAssessed && route.exposedMetres > 0
            return (
              <button
                key={route.key}
                type="button"
                data-testid={`route-option-${route.rank}`}
                aria-pressed={active}
                aria-label={`Route ${route.rank} to ${route.destination}, ${formatDistance(route.metres)}, ${formatDuration(route.seconds)}${
                  wet ? `, ${formatDistance(route.exposedMetres)} through flood water` : ''
                }`}
                title={route.destination}
                onClick={() => {
                  setSelectedKey(route.key)
                  onSelectRoute?.(route.rank)
                }}
                className={`px-2 py-1 text-ui rounded border cursor-pointer text-left ${
                  active
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-800 border-slate-700 hover:bg-slate-700'
                }`}
              >
                <span className="block">
                  Route {route.rank} · {formatDistance(route.metres)}
                  {route.rank === 1 && (
                    <span
                      className={`ml-1 ${active ? 'text-blue-100' : 'text-emerald-300'}`}
                      data-testid="route-option-safest"
                    >
                      · safest
                    </span>
                  )}
                </span>
                {/* Why this one is ranked where it is, rather than leaving distance to imply it. */}
                <span
                  className={`block text-meta ${
                    wet
                      ? active
                        ? 'text-amber-100'
                        : 'text-amber-300'
                      : active
                        ? 'text-blue-100'
                        : 'text-slate-400'
                  }`}
                >
                  {route.crossingsAssessed
                    ? wet
                      ? `${formatDistance(route.exposedMetres)} in water`
                      : 'clear of flooding'
                    : 'flooding unassessed'}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {(unavoided || crossesFlood) && (
        <p
          role="alert"
          data-testid="route-flood-warning"
          className="mx-3 mb-2 px-2 py-1.5 text-ui rounded bg-amber-950/70 text-amber-200 border border-amber-800"
        >
          {unavoided
            ? 'Flood exclusions could not be applied — this route may cross a flood zone.'
            : `Crosses a flood zone ${selected.crossings} time${selected.crossings === 1 ? '' : 's'}.`}
        </p>
      )}

      {!collapsed && (
        <ol
          data-testid="route-steps"
          className="overflow-y-auto max-h-52 px-1 pb-2 flex flex-col"
        >
          {selected.steps.map((step, index) => {
            const maneuver: RouteManeuver = step.maneuver ?? 'straight'
            const focusable = onFocusStep !== undefined && step.at !== undefined

            const body = (
              <>
                <span className="shrink-0 mt-0.5 text-slate-300">
                  <ManeuverIcon maneuver={maneuver} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-ui leading-snug text-slate-100">
                    {step.instruction}
                  </span>
                  {step.streetNames && step.streetNames.length > 0 && (
                    <span className="block text-meta text-slate-400 truncate">
                      {step.streetNames.join(' · ')}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-ui tabular-nums text-slate-200">
                    {step.metres > 0 ? formatDistance(step.metres) : '—'}
                  </span>
                  <span className="block text-meta tabular-nums text-slate-400">
                    {formatDistance(distanceIn[index] ?? 0)} in
                  </span>
                </span>
              </>
            )

            return (
              <li key={`${index}-${step.instruction}`} data-testid={`route-step-${index}`}>
                {focusable ? (
                  <button
                    type="button"
                    onClick={() => onFocusStep!(step.at!)}
                    className="w-full text-left flex items-start gap-2 px-2 py-1.5 rounded hover:bg-slate-800 cursor-pointer"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex items-start gap-2 px-2 py-1.5">{body}</div>
                )}
              </li>
            )
          })}
        </ol>
      )}

      <p className="px-3 pb-2 text-meta text-slate-400">
        {selected.simulated ? 'Simulated route — not for real-world emergency navigation. ' : ''}
        Decision support only; follow instructions from the responsible authority.
      </p>
    </section>
  )
}
