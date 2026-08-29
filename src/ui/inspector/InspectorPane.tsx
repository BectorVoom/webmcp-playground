import { useMemo, useState } from 'react'
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
 * Rendering is windowed to the most recent N matching events rather than
 * virtualised with a dependency: with filters available, "the latest 300 of
 * 4,812" is both responsive and honest about what is on screen (N2).
 */
const WINDOW_STEP = 300

export function InspectorPane() {
  const session = useSession()
  const events = useStore(session.traceStore)
  const [category, setCategory] = useState<TraceCategory | 'all'>('all')
  const [turnFilter, setTurnFilter] = useState<string>('all')
  const [limit, setLimit] = useState(WINDOW_STEP)

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

  const visible = filtered.slice(Math.max(0, filtered.length - limit))
  const discarded = session.traceStore.discardedCount()

  return (
    <aside
      data-pane="inspector"
      data-testid="inspector-pane"
      className="flex w-96 shrink-0 flex-col overflow-hidden border-l border-border-subtle text-xs"
    >
      <div className="flex flex-col gap-2 border-b border-border-subtle p-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Inspector</h2>
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
              onClick={() => setCategory(option)}
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
            onChange={(event) => setTurnFilter(event.target.value)}
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
          showing {visible.length} of {filtered.length} matching ({events.length} total
          {discarded > 0 ? `, ${discarded} discarded` : ''})
          {visible.length < filtered.length && (
            <button
              type="button"
              data-testid="inspector-button-more"
              className="ml-2 underline decoration-dotted"
              onClick={() => setLimit((n) => n + WINDOW_STEP)}
            >
              show older
            </button>
          )}
        </div>
      </div>

      <ol data-testid="inspector-events" className="flex-1 overflow-y-auto p-2">
        {visible.length === 0 && <li className="text-ink-muted">no matching events</li>}
        {visible.map((event) => (
          <InspectorRow key={event.seq} event={event} />
        ))}
      </ol>
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
        className="text-[11px] text-accent underline decoration-dotted"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} model reasoning ({text.length} chars)
      </button>
      {open && (
        <p
          data-testid={`inspector-reasoning-${seq}`}
          className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-accent/5 p-2 text-[11px] leading-relaxed"
        >
          {text}
        </p>
      )}
    </div>
  )
}

function InspectorRow({ event }: { event: TraceEvent }) {
  const level = levelOf(event.payload)
  const reasoning =
    event.payload.kind === 'ModelResponded' ? (event.payload.reasoning ?? null) : null
  return (
    <li
      data-testid={`inspector-event-${event.seq}`}
      className="border-b border-border-subtle/60 py-1.5 last:border-0"
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
        <div className="pl-6 font-mono text-[10px] text-ink-muted">
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
