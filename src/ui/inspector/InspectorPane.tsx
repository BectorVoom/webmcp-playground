import { useMemo, useRef, useState } from 'react'
import {
  measureElement as measureVirtualRow,
  observeElementRect,
  useVirtualizer,
} from '@tanstack/react-virtual'
import { useStore } from '../hooks/useRun'
import { useSession } from '../session-context'
import { CopyButton, JsonBlock } from '../common/Json'
import {
  categoryOf,
  levelOf,
  summarise,
  type TraceCategory,
  type TraceEvent,
} from '../../domain/trace'

const CATEGORIES: ReadonlyArray<TraceCategory | 'all'> = [
  'all',
  'model',
  'tools',
  'turn',
  'adapter',
  'error',
  'log',
  'session',
]

const LEVEL_TONE: Record<string, string> = {
  debug: 'text-ink-muted',
  info: 'text-ink',
  warn: 'text-warn',
  error: 'text-danger',
}

/**
 * The inspector is a peer of the chat, not a drawer behind it (R5.2).
 *
 * All matching events remain reachable by scrolling, while the virtualiser
 * mounts only the rows around the viewport. Rows have expandable content, so
 * their measured height — rather than a guessed fixed height — controls their
 * placement (N2).
 */
const ESTIMATED_ROW_HEIGHT = 104
const ESTIMATED_VIEWPORT_HEIGHT = 600

export function InspectorPane() {
  // TanStack Virtual keeps mutable scroll and measurement state, which React Compiler must not memoise.
  'use no memo'
  const session = useSession()
  const events = useStore(session.traceStore)
  const [category, setCategory] = useState<TraceCategory | 'all'>('all')
  const [turnFilter, setTurnFilter] = useState<string>('all')
  const scrollRef = useRef<HTMLDivElement>(null)

  const turnIds = useMemo(() => {
    const ids = new Set<string>()
    for (const event of events) if (event.turnId !== undefined) ids.add(event.turnId)
    return [...ids]
  }, [events])

  const filtered = useMemo(
    () =>
      events.filter(
        (event) =>
          (category === 'all' || categoryOf(event.payload) === category) &&
          (turnFilter === 'all' || event.turnId === turnFilter),
      ),
    [events, category, turnFilter],
  )

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    observeElementRect: (instance, callback) =>
      observeElementRect(instance, (rect) =>
        callback(
          rect.height === 0 ? { ...rect, height: ESTIMATED_VIEWPORT_HEIGHT } : rect,
        ),
      ),
    measureElement: (element, entry, instance) => {
      const height = measureVirtualRow(element, entry, instance)
      return height === 0 ? ESTIMATED_ROW_HEIGHT : height
    },
    // Renders a useful first range before the browser has reported the pane's
    // dimensions. The observer immediately replaces this estimate in a real layout.
    initialRect: { width: 0, height: ESTIMATED_VIEWPORT_HEIGHT },
    overscan: 8,
  })
  const discarded = session.traceStore.discardedCount()

  const resetScroll = () => virtualizer.scrollToOffset(0)

  return (
    <aside
      data-pane="inspector"
      data-testid="inspector-pane"
      className="flex w-96 shrink-0 flex-col overflow-hidden border-l border-border-subtle text-ui"
    >
      <div className="flex flex-col gap-2 border-b border-border-subtle p-2">
        <div className="flex items-center justify-between">
          <h2 className="text-body font-semibold">Inspector</h2>
          <CopyButton value={session.exportTrace()} testId="inspector-copy-all" />
        </div>

        <div className="flex flex-wrap gap-1">
          {CATEGORIES.map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`inspector-filter-${option}`}
              aria-pressed={category === option}
              className={`rounded border px-1.5 py-0.5 ${
                category === option
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-border-subtle text-ink-muted hover:text-ink'
              }`}
              onClick={() => {
                setCategory(option)
                resetScroll()
              }}
            >
              {option}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2">
          turn
          <select
            data-testid="inspector-filter-turn"
            className="rounded border border-border-subtle bg-surface px-1 py-0.5"
            value={turnFilter}
            onChange={(event) => {
              setTurnFilter(event.target.value)
              resetScroll()
            }}
          >
            <option value="all">all</option>
            {turnIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          {turnFilter !== 'all' && (
            <CopyButton
              value={filtered}
              testId="inspector-copy-turn"
            />
          )}
        </label>

        <div className="text-ink-muted" data-testid="inspector-count">
          {filtered.length} matching ({events.length} total
          {discarded > 0 ? `, ${discarded} discarded` : ''})
        </div>
      </div>

      <div
        ref={scrollRef}
        data-testid="inspector-events"
        className="flex-1 overflow-y-auto p-2"
      >
        {filtered.length === 0 ? (
          <div className="text-ink-muted">no matching events</div>
        ) : (
          <ol
            className="relative m-0 list-none p-0"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((row) => {
              const event = filtered[row.index]
              if (event === undefined) return null
              return (
                <InspectorRow
                  key={event.seq}
                  event={event}
                  index={row.index}
                  start={row.start}
                  measureElement={virtualizer.measureElement}
                />
              )
            })}
          </ol>
        )}
      </div>
    </aside>
  )
}

/**
 * A thinking model's reasoning is the most direct evidence available for whether
 * a tool description is doing its job, so it gets its own readable block rather
 * than being left for someone to dig out of the raw JSON.
 */
function Reasoning({ text, seq }: { text: string; seq: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="pl-6">
      <button
        type="button"
        data-testid={`inspector-reasoning-${seq}-toggle`}
        className="text-ui text-accent underline decoration-dotted"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} model reasoning ({text.length} chars)
      </button>
      {open && (
        <p
          data-testid={`inspector-reasoning-${seq}`}
          className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-accent/5 p-2 text-body"
        >
          {text}
        </p>
      )}
    </div>
  )
}

function InspectorRow({
  event,
  index,
  start,
  measureElement,
}: {
  readonly event: TraceEvent
  readonly index: number
  readonly start: number
  readonly measureElement: (element: Element | null) => void
}) {
  const level = levelOf(event.payload)
  const reasoning =
    event.payload.kind === 'ModelResponded' ? (event.payload.reasoning ?? null) : null
  return (
    <li
      ref={measureElement}
      data-index={index}
      data-testid={`inspector-event-${event.seq}`}
      className="absolute left-0 top-0 w-full border-b border-border-subtle/60 py-1.5"
      style={{ transform: `translateY(${start}px)` }}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-ink-muted">#{event.seq}</span>
        <span className={`font-mono font-semibold ${LEVEL_TONE[level] ?? ''}`}>
          {event.payload.kind}
        </span>
        {event.durationMs !== undefined && (
          <span className="text-ink-muted">{event.durationMs} ms</span>
        )}
        <CopyButton value={event} testId={`inspector-copy-${event.seq}`} />
      </div>
      <div className="pl-6 text-ink-muted">{summarise(event)}</div>
      {(event.turnId !== undefined || event.requestId !== undefined) && (
        <div className="pl-6 font-mono text-meta text-ink-muted">
          {[event.turnId, event.callId, event.requestId].filter(Boolean).join(' · ')}
        </div>
      )}
      {reasoning !== null && reasoning !== '' && (
        <Reasoning text={reasoning} seq={event.seq} />
      )}
      <div className="pl-6">
        <JsonBlock value={event} testId={`inspector-json-${event.seq}`} />
      </div>
    </li>
  )
}
