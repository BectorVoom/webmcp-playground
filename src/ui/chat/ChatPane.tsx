import { useEffect, useRef, useState } from 'react'
import { useStore } from '../hooks/useRun'
import { useSession } from '../session-context'
import { JsonBlock } from '../common/Json'
import { ErrorNotice } from '../common/ErrorNotice'
import type { Turn } from '../../domain/chat'

const STATE_LABEL: Record<Turn['state'], string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  step_limit_exceeded: 'stopped at step limit',
}

function ToolCallEntry({ call, index }: { call: Turn['toolCalls'][number]; index: number }) {
  const failed = call.errorTag !== undefined
  return (
    <li
      data-testid={`chat-toolcall-${call.callId}`}
      className={`rounded border px-2 py-1.5 ${
        failed ? 'border-danger/40 bg-danger/5' : 'border-border-subtle bg-surface-raised'
      }`}
    >
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-ink-muted">#{index + 1}</span>
        <span className="font-mono font-semibold">{call.name}</span>
        <span className="text-ink-muted">{call.durationMs ?? 0} ms</span>
        <span className={failed ? 'text-danger' : 'text-ok'}>{failed ? '✕' : '✓'}</span>
      </div>
      <JsonBlock value={call.input} testId={`chat-toolcall-input-${call.callId}`} label="input" />
      {call.result !== undefined && (
        <JsonBlock
          value={call.result}
          testId={`chat-toolcall-result-${call.callId}`}
          label="result"
        />
      )}
      {failed && (
        <div className="mt-1">
          <ErrorNotice
            testId={`chat-toolcall-error-${call.callId}`}
            tag={call.errorTag!}
            message={call.errorMessage ?? ''}
            correlation={[call.callId]}
          />
        </div>
      )}
    </li>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  const session = useSession()
  return (
    <li data-testid={`chat-turn-${turn.id}`} className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-semibold text-accent">
          you
        </span>
        <p className="whitespace-pre-wrap">{turn.userMessage}</p>
      </div>

      {turn.toolCalls.length > 0 && (
        <ul className="ml-6 flex flex-col gap-1.5">
          {turn.toolCalls.map((call, index) => (
            <ToolCallEntry key={call.callId} call={call} index={index} />
          ))}
        </ul>
      )}

      {turn.finalText !== null && (
        <div className="flex items-baseline gap-2">
          <span className="rounded bg-ok/15 px-1.5 py-0.5 text-[11px] font-semibold text-ok">
            assistant
          </span>
          <p className="whitespace-pre-wrap">{turn.finalText}</p>
        </div>
      )}

      {turn.errorTag !== undefined && (
        <div className="ml-6">
          <ErrorNotice
            testId={`chat-turn-error-${turn.id}`}
            tag={turn.errorTag}
            message={turn.errorMessage ?? ''}
            remedy={turn.remedy}
            correlation={[turn.id]}
            variant={turn.state === 'step_limit_exceeded' ? 'warn' : 'error'}
          />
        </div>
      )}

      <div className="ml-6 flex items-center gap-2 text-[11px] text-ink-muted">
        <span data-testid={`chat-turn-state-${turn.id}`}>
          {STATE_LABEL[turn.state]} · {turn.steps} step(s) ·{' '}
          {turn.endedAt === undefined ? '—' : `${turn.endedAt - turn.startedAt} ms`}
        </span>
        {turn.state !== 'completed' && (
          <button
            type="button"
            data-testid={`chat-button-retry-${turn.id}`}
            className="rounded border border-border-subtle px-1.5 py-0.5 hover:bg-surface-raised"
            onClick={() => void session.retryTurn(turn.id)}
          >
            retry
          </button>
        )}
      </div>
    </li>
  )
}

export function ChatPane() {
  const session = useSession()
  const state = useStore(session.state)
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Guarded: jsdom and some embedded webviews do not implement
    // scrollIntoView, and an autoscroll convenience must never break rendering.
    const end = endRef.current
    if (typeof end?.scrollIntoView === 'function') end.scrollIntoView({ block: 'end' })
  }, [state.turns.length, state.status])

  const running = state.status === 'running'

  const submit = () => {
    const text = draft.trim()
    if (text === '' || running) return
    setDraft('')
    void session.sendMessage(text).catch(() => undefined)
  }

  return (
    <section
      data-pane="chat"
      data-testid="chat-pane"
      className="flex min-w-0 flex-1 flex-col overflow-hidden"
    >
      {state.notice !== null && (
        <div
          data-testid="chat-notice"
          className="border-b border-warn/30 bg-warn/10 px-3 py-2 text-xs text-ink"
        >
          {state.notice}
        </div>
      )}

      <ol
        data-testid="chat-transcript"
        aria-live="polite"
        aria-label="Conversation transcript"
        className="flex flex-1 flex-col gap-5 overflow-y-auto p-4 text-sm"
      >
        {state.turns.length === 0 && (
          <li className="text-ink-muted">
            Send a message to start. With the scripted driver, try “add milk”, “please fail”,
            “hang please”, or “loop forever”.
          </li>
        )}
        {state.turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
        {running && (
          <li data-testid="chat-running" className="text-ink-muted">
            running…
          </li>
        )}
        <div ref={endRef} />
      </ol>

      <div className="flex gap-2 border-t border-border-subtle p-3">
        <textarea
          data-testid="chat-input-message"
          aria-label="Message"
          rows={2}
          className="flex-1 resize-none rounded border border-border-subtle bg-surface px-2 py-1.5 text-sm"
          placeholder="Message…"
          value={draft}
          disabled={running}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        {running ? (
          <button
            type="button"
            data-testid="chat-button-cancel"
            className="self-end rounded border border-danger/50 px-3 py-1.5 text-sm text-danger hover:bg-danger/10"
            onClick={() => session.cancel()}
          >
            cancel
          </button>
        ) : (
          <button
            type="button"
            data-testid="chat-button-send"
            className="self-end rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
            disabled={draft.trim() === ''}
            onClick={submit}
          >
            send
          </button>
        )}
      </div>
    </section>
  )
}
