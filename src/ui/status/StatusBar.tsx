import { useRef, useState } from 'react'
import { useStore } from '../hooks/useRun'
import { useSession } from '../session-context'

/**
 * R5.12. Everything needed to answer "what is this page doing right now?"
 * without opening anything: which adapter and which draft, which driver and
 * model, whether the backend is up, how many tools are live, and turn state.
 */
export function StatusBar() {
  const session = useSession()
  const state = useStore(session.state)
  const fileRef = useRef<HTMLInputElement>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const toolSets = useStore(session.manager.status)
  const toolCount = toolSets
    .filter((s) => s.enabled)
    .reduce((n, s) => n + s.tools.filter((t) => t.status === 'registered').length, 0)

  const backend =
    state.health === null
      ? { label: 'backend ?', tone: 'text-warn' }
      : state.health.upstream.reachable
        ? { label: 'backend ✓', tone: 'text-ok' }
        : { label: 'backend ✓ / no LLM', tone: 'text-warn' }

  return (
    <header
      data-testid="status-bar"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-subtle bg-surface-raised px-3 py-2 text-xs"
    >
      <span className="font-semibold">WebMCP playground</span>

      <span data-testid="status-adapter" title={state.specRevision.url}>
        adapter <span className="font-mono">{state.adapterId}</span>{' '}
        <span className="text-ink-muted">({state.specRevision.label})</span>
      </span>

      <span data-testid="status-driver">
        driver <span className="font-mono">{state.driverId}</span>
        {' · '}
        model <span className="font-mono">{state.model || '—'}</span>
      </span>

      <span data-testid="status-backend" className={backend.tone}>
        {backend.label}
      </span>

      <span data-testid="status-tools">tools {toolCount}</span>

      <span data-testid="status-turn" className={state.status === 'running' ? 'text-accent' : ''}>
        {state.status}
      </span>

      {saved !== null && (
        <span data-testid="status-saved-path" className="font-mono text-ok">
          wrote {saved}
        </span>
      )}

      <span className="ml-auto flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          data-testid="status-input-import"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file === undefined) return
            void file.text().then((text) => {
              try {
                session.importTrace(JSON.parse(text))
              } catch {
                session.importTrace(null)
              }
            })
          }}
        />
        <button
          type="button"
          data-testid="status-button-import"
          className="rounded border border-border-subtle px-2 py-0.5 hover:bg-surface"
          onClick={() => fileRef.current?.click()}
        >
          import trace
        </button>
        <button
          type="button"
          data-testid="status-button-save"
          className="rounded border border-border-subtle px-2 py-0.5 hover:bg-surface"
          title="Write the trace to .traces/<sessionId>.json so it can be read from disk"
          onClick={() => {
            void session
              .saveTrace()
              .then((result) => setSaved(result.path))
              .catch(() => setSaved(null))
          }}
        >
          save trace
        </button>
        <button
          type="button"
          data-testid="status-button-export"
          className="rounded border border-border-subtle px-2 py-0.5 hover:bg-surface"
          onClick={() => {
            const blob = new Blob([JSON.stringify(session.exportTrace(), null, 2)], {
              type: 'application/json',
            })
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = `${session.sessionId}.json`
            anchor.click()
            URL.revokeObjectURL(url)
          }}
        >
          export trace
        </button>
        <button
          type="button"
          data-testid="status-button-reset"
          className="rounded border border-border-subtle px-2 py-0.5 hover:bg-surface"
          onClick={() => void session.reset()}
        >
          reset
        </button>
      </span>
    </header>
  )
}
