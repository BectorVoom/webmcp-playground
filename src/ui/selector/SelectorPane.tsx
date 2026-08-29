import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../hooks/useRun'
import { useSession } from '../session-context'
import { JsonBlock } from '../common/Json'
import { ErrorNotice } from '../common/ErrorNotice'
import { ADAPTERS } from '../../adapters/webmcp/registry'
import type { AdapterId } from '../../ports/ToolHost'
import type { DriverId, ToolCallStrategy } from '../../ports/LlmClient'
import type { FaultKind } from '../../domain/trace'
import type { HostTool } from '../../domain/tool'
import { Effect } from 'effect'

const FAULTS: ReadonlyArray<FaultKind> = ['fail', 'hang', 'invalid']

/**
 * The WebMCP selector (R2). It answers three questions at once: what did we ask
 * the host for, what does the host actually hold, and what is it publishing to
 * the model. Keeping all three on screen is what makes a divergence between
 * them noticeable rather than baffling.
 */
export function SelectorPane() {
  const session = useSession()
  const state = useStore(session.state)
  const toolSets = useStore(session.manager.status)
  const [hostTools, setHostTools] = useState<ReadonlyArray<HostTool>>([])
  const [conflict, setConflict] = useState<{ tool: string; sets: ReadonlyArray<string> } | null>(
    null,
  )

  const refresh = useCallback(() => {
    void session.runtime
      .runPromise(Effect.orElseSucceed(session.host().listTools(), () => []))
      .then(setHostTools)
  }, [session])

  // Refresh on every host-driven change, within one frame (R2.5). Subscribing
  // in an effect rather than through useSyncExternalStore because the host
  // itself is swappable, so the subscription target is not stable.
  useEffect(() => {
    refresh()
    let frame = 0
    const unsubscribe = session.host().subscribeToChanges(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(refresh)
    })
    return () => {
      cancelAnimationFrame(frame)
      unsubscribe()
    }
  }, [session, refresh, state.adapterId])

  const toggle = (id: string, enabled: boolean) => {
    const next = enabled
      ? toolSets.filter((s) => s.enabled || s.id === id).map((s) => s.id)
      : toolSets.filter((s) => s.enabled && s.id !== id).map((s) => s.id)
    setConflict(null)
    void session.setToolSets(next).then(refresh)
  }

  return (
    <aside
      data-pane="selector"
      data-testid="selector-pane"
      className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border-subtle p-3 text-xs"
    >
      <section>
        <h2 className="mb-2 font-semibold">Tool sets</h2>
        <ul className="flex flex-col gap-1.5">
          {toolSets.map((set) => (
            <li key={set.id}>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  data-testid={`selector-toolset-toggle-${set.id}`}
                  checked={set.enabled}
                  onChange={(event) => toggle(set.id, event.target.checked)}
                />
                <span>
                  <span className="font-mono">{set.id}</span>{' '}
                  <span className="text-ink-muted">({set.toolCount})</span>
                  <span className="block text-ink-muted">{set.description}</span>
                </span>
              </label>
              {set.tools.some((t) => t.status === 'failed') && (
                <ul className="ml-6 mt-1">
                  {set.tools
                    .filter((t) => t.status === 'failed')
                    .map((tool) => (
                      <li key={tool.name} className="text-danger">
                        {tool.name}: {tool.error}
                      </li>
                    ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {conflict !== null && (
          <div className="mt-2">
            <ErrorNotice
              testId="selector-error-duplicate"
              tag="DuplicateToolName"
              message={`"${conflict.tool}" is declared by ${conflict.sets.join(' and ')}.`}
              remedy="Disable one of those sets."
            />
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">
          Registered on host{' '}
          <button
            type="button"
            data-testid="selector-button-refresh-tools"
            className="ml-1 font-normal text-ink-muted underline decoration-dotted"
            onClick={refresh}
          >
            refresh
          </button>
        </h2>
        <p className="mb-1 text-ink-muted">
          Read back from the host, not from local state — a divergence here is a real finding.
        </p>
        <ul data-testid="selector-host-tools" className="flex flex-col gap-1">
          {hostTools.length === 0 && <li className="text-ink-muted">none — press refresh</li>}
          {hostTools.map((tool) => (
            <li key={tool.name}>
              <span className="font-mono">{tool.name}</span>
              <JsonBlock
                value={tool.inputSchema}
                testId={`selector-schema-${tool.name}`}
                label="schema"
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Runtime</h2>

        <label className="flex flex-col gap-1">
          adapter
          <select
            data-testid="selector-select-adapter"
            className="rounded border border-border-subtle bg-surface px-1 py-0.5"
            value={state.config.adapter ?? 'auto'}
            onChange={(event) => {
              const value = event.target.value
              void session
                .setAdapter(value === 'auto' ? undefined : (value as AdapterId))
                .then(refresh)
            }}
          >
            <option value="auto">auto-detect</option>
            {ADAPTERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          driver
          <select
            data-testid="selector-select-driver"
            className="rounded border border-border-subtle bg-surface px-1 py-0.5"
            value={state.driverId}
            onChange={(event) => void session.setDriver(event.target.value as DriverId)}
          >
            <option value="scripted">scripted (deterministic, no LLM)</option>
            <option value="local">local (OpenAI-compatible endpoint)</option>
          </select>
        </label>

        {state.models.length > 0 && (
          <label className="flex flex-col gap-1">
            model
            <select
              data-testid="selector-select-model"
              className="rounded border border-border-subtle bg-surface px-1 py-0.5"
              value={state.model}
              onChange={(event) => void session.setModel(event.target.value)}
            >
              {state.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1">
          tool-call strategy
          <select
            data-testid="selector-select-strategy"
            className="rounded border border-border-subtle bg-surface px-1 py-0.5"
            value={state.config.strategy}
            onChange={(event) => session.setStrategy(event.target.value as ToolCallStrategy)}
          >
            <option value="native">native (tools parameter)</option>
            <option value="prompted">prompted (JSON in the reply)</option>
          </select>
        </label>

        <label className="flex items-center gap-2">
          max steps
          <input
            type="number"
            min={1}
            data-testid="selector-input-max-steps"
            className="w-16 rounded border border-border-subtle bg-surface px-1 py-0.5"
            value={state.config.maxSteps}
            onChange={(event) => session.setMaxSteps(Number(event.target.value) || 1)}
          />
        </label>

        <label className="flex items-center gap-2">
          tool timeout (ms)
          <input
            type="number"
            min={100}
            step={100}
            data-testid="selector-input-tool-timeout"
            className="w-24 rounded border border-border-subtle bg-surface px-1 py-0.5"
            value={state.config.toolTimeoutMs}
            onChange={(event) => session.setToolTimeout(Number(event.target.value) || 100)}
          />
        </label>
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Inject a fault</h2>
        <p className="mb-1 text-ink-muted">
          Arms the next tool call. Reproducing an error path should cost one click, not an hour.
        </p>
        <div className="flex gap-1">
          {FAULTS.map((kind) => (
            <button
              key={kind}
              type="button"
              data-testid={`selector-button-fault-${kind}`}
              className="rounded border border-border-subtle px-2 py-0.5 hover:bg-surface-raised"
              onClick={() => session.injectFault({ kind, count: 1 })}
            >
              {kind}
            </button>
          ))}
          <button
            type="button"
            data-testid="selector-button-fault-clear"
            className="rounded border border-border-subtle px-2 py-0.5 hover:bg-surface-raised"
            onClick={() => session.faults.clear()}
          >
            clear
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Adapter detection</h2>
        <ul className="flex flex-col gap-1">
          {state.detection.candidates.map((candidate) => (
            <li
              key={candidate.id}
              data-testid={`selector-detection-${candidate.id}`}
              className={candidate.supported ? 'text-ok' : 'text-ink-muted'}
            >
              <span className="font-mono">{candidate.id}</span>: {candidate.reason}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}
