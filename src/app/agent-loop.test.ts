import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { createTraceStore } from '../adapters/trace/memory-store'
import { makeMemorySink } from '../adapters/trace/memory-sink'
import { makeInMemoryHost } from '../adapters/webmcp/in-memory'
import { makeScriptedClient } from '../adapters/llm/scripted'
import { asSessionId, asTurnId, createIdFactory } from '../domain/ids'
import { TOOL_SETS, resetTodos } from '../toolsets'
import { createFaultInjector } from './fault-injector'
import { createToolRunner } from './tool-runner'
import { createToolRegistryManager } from './tool-registry'
import { runTurn, type TurnDeps } from './agent-loop'

/**
 * The whole loop, end to end, with no browser WebMCP and no LLM — deterministic
 * by construction (checkpoint 6). If these ever go flaky, the determinism
 * promise in ADR-2 and R4.3 has been broken somewhere.
 */

const build = async (options: { timeoutMs?: number; maxSteps?: number } = {}) => {
  resetTodos()
  const store = createTraceStore(asSessionId('sess_loop'))
  const sink = makeMemorySink(store)
  const faults = createFaultInjector()
  // One factory for the loop and the runner alike, as a session has: the ids in
  // the trace only line up if both draw from the same sequence.
  const ids = createIdFactory()
  const runner = createToolRunner({
    sink,
    faults,
    ids,
    timeoutMs: () => options.timeoutMs ?? 1000,
    currentTurnId: () => undefined,
  })
  const host = makeInMemoryHost(runner, sink)
  const manager = createToolRegistryManager(TOOL_SETS, host, sink)
  await Effect.runPromise(manager.setEnabled(['todo', 'diagnostics', 'forms']))

  const controller = new AbortController()
  const deps: TurnDeps = {
    host,
    client: makeScriptedClient(),
    sink,
    ids,
    model: 'scripted',
    strategy: 'native',
    maxSteps: options.maxSteps ?? 8,
    signal: controller.signal,
  }
  return { store, sink, faults, host, deps, controller }
}

const kinds = (store: ReturnType<typeof createTraceStore>) =>
  store.snapshot().map((e) => e.payload.kind)

describe('runTurn', () => {
  it('completes a multi-step turn, calling tools along the way', async () => {
    const { deps, store } = await build()
    const turn = await Effect.runPromise(runTurn(asTurnId('turn_1'), [], 'add milk', deps))

    expect(turn.state).toBe('completed')
    expect(turn.toolCalls.map((c) => c.name)).toEqual(['todo.add', 'todo.list'])
    expect(turn.finalText).toContain('added it')
    expect(kinds(store)).toContain('TurnCompleted')
  })

  it('records the tools the model was offered at every step, read from the host', async () => {
    const { deps, store } = await build()
    await Effect.runPromise(runTurn(asTurnId('turn_1'), [], 'add milk', deps))

    const listed = store.snapshot().filter((e) => e.payload.kind === 'ToolsListed')
    expect(listed.length).toBeGreaterThanOrEqual(2)
    expect(listed[0]?.payload).toMatchObject({ source: 'host' })
  })

  it('carries verbatim model output into the trace', async () => {
    const { deps, store } = await build()
    await Effect.runPromise(runTurn(asTurnId('turn_1'), [], 'echo hello', deps))

    const responded = store.snapshot().find((e) => e.payload.kind === 'ModelResponded')
    expect(responded?.payload).toHaveProperty('raw')
    expect((responded?.payload as { raw: { driver: string } }).raw.driver).toBe('scripted')
  })

  it('feeds a tool failure back to the model and still completes (ADR-7)', async () => {
    const { deps, store } = await build()
    const turn = await Effect.runPromise(runTurn(asTurnId('turn_1'), [], 'please fail', deps))

    expect(turn.state).toBe('completed')
    expect(turn.toolCalls[0]?.errorTag).toBe('ToolExecutionError')
    const toolMessage = turn.messages.find((m) => m.role === 'tool')
    expect(toolMessage).toMatchObject({ role: 'tool' })
    expect((toolMessage as { content: string }).content).toContain('ToolExecutionError')
    expect(kinds(store)).toContain('ToolCallFailed')
  })

  it('applies the per-call timeout to a hanging tool without killing the turn', async () => {
    const { deps } = await build({ timeoutMs: 50 })
    const turn = await Effect.runPromise(runTurn(asTurnId('turn_1'), [], 'hang please', deps))

    expect(turn.toolCalls[0]?.errorTag).toBe('ToolTimeout')
    expect(turn.state).toBe('completed')
  })

  it('stops at the step limit and keeps the partial transcript (R1.5)', async () => {
    const { deps } = await build({ maxSteps: 3 })
    const turn = await Effect.runPromise(runTurn(asTurnId('turn_1'), [], 'loop forever', deps))

    expect(turn.state).toBe('step_limit_exceeded')
    expect(turn.steps).toBe(3)
    expect(turn.toolCalls).toHaveLength(3)
    expect(turn.remedy).toContain('step limit')
  })

  it('cancels an in-flight turn when the signal fires (R1.3)', async () => {
    const { deps, controller, store } = await build({ timeoutMs: 60_000 })
    const promise = Effect.runPromise(runTurn(asTurnId('turn_1'), [], 'hang please', deps))
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()

    const turn = await promise
    expect(turn.state).toBe('cancelled')
    expect(kinds(store)).toContain('TurnCancelled')
  })

  it('surfaces an injected fault as a tool failure the model can see', async () => {
    const { deps, faults } = await build()
    faults.arm({ kind: 'fail', count: 1 })
    const turn = await Effect.runPromise(runTurn(asTurnId('turn_1'), [], 'add milk', deps))

    expect(turn.toolCalls[0]?.errorTag).toBe('ToolExecutionError')
    expect(turn.toolCalls[0]?.errorMessage).toContain('Injected fault')
  })

  it('rejects model-supplied input that violates the schema, before the tool runs', async () => {
    const { host } = await build()
    const error = await Effect.runPromise(
      Effect.flip(host.execute('todo.add', { text: 42 }, { signal: new AbortController().signal })),
    )
    expect(error._tag).toBe('ToolInputInvalid')
    expect(error).toMatchObject({ issues: [{ path: 'text' }] })
  })

  it('degrades gracefully when a tool returns a malformed result', async () => {
    const { deps } = await build()
    const turn = await Effect.runPromise(
      runTurn(asTurnId('turn_1'), [], 'add milk', {
        ...deps,
        client: {
          id: 'scripted',
          listModels: () => Effect.succeed([]),
          complete: (request) =>
            Effect.succeed({
              text: request.messages.some((m) => m.role === 'tool') ? 'done' : null,
              toolCalls: request.messages.some((m) => m.role === 'tool')
                ? []
                : [{ id: 'c1', name: 'debug.invalid_output', input: {} }],
              raw: {},
              requestId: request.requestId,
            }),
        },
      }),
    )

    expect(turn.state).toBe('completed')
    const toolMessage = turn.messages.find((m) => m.role === 'tool')
    // The point: something readable reached the model rather than an empty string.
    expect((toolMessage as { content: string }).content.length).toBeGreaterThan(0)
  })

  it('fails explicitly when the model returns nothing twice running', async () => {
    // Found against gemma4:e4b in prompted mode: a thinking model can reason its
    // way to a decision and then end the turn without stating it. The loop asks
    // once more before giving up; a model that is silent both times has still
    // said nothing, and completing here would show a blank answer and call it
    // success.
    const { deps, store } = await build()
    const turn = await Effect.runPromise(
      runTurn(asTurnId('turn_1'), [], 'anything', {
        ...deps,
        client: {
          id: 'scripted',
          listModels: () => Effect.succeed([]),
          complete: (request) =>
            Effect.succeed({
              text: '',
              reasoning: 'I was still thinking about what to do when I ran out of room…',
              toolCalls: [],
              raw: {},
              requestId: request.requestId,
            }),
        },
      }),
    )

    expect(turn.state).toBe('failed')
    expect(turn.errorTag).toBe('EmptyModelResponse')
    expect(turn.errorMessage).toContain('reasoning')
    expect(turn.remedy).toContain('native strategy')
    // The retry is not free, so the trace says it happened rather than leaving
    // the step looking like one request that took twice as long.
    expect(kinds(store).filter((k) => k === 'EmptyResponseRetried')).toHaveLength(1)
    expect(kinds(store).filter((k) => k === 'ModelRequested')).toHaveLength(2)
  })

  it('recovers when the nudged re-ask produces an answer', async () => {
    // Measured against gemma4:e4b: 7 of 36 asks came back empty, and one
    // re-ask carrying the nudge recovered all 7.
    const { deps, store } = await build()
    const turn = await Effect.runPromise(
      runTurn(asTurnId('turn_1'), [], 'please say nothing at first', deps),
    )

    expect(turn.state).toBe('completed')
    expect(turn.finalText).toContain('Here is the answer.')
    expect(kinds(store)).toContain('EmptyResponseRetried')
    // One step, asked twice — the recovery must not consume the step budget.
    expect(turn.steps).toBe(1)
  })

  it('keeps the nudge out of the transcript', async () => {
    const { deps } = await build()
    const turn = await Effect.runPromise(
      runTurn(asTurnId('turn_1'), [], 'please say nothing at first', deps),
    )

    // The nudge prods one request. Leaving it in the messages would carry the
    // scolding into every later step of the conversation.
    expect(turn.messages.some((m) => m.role === 'system')).toBe(false)
  })

  it('asks only once more, never in a loop', async () => {
    const { deps, store } = await build()
    let asks = 0
    await Effect.runPromise(
      runTurn(asTurnId('turn_1'), [], 'anything', {
        ...deps,
        maxSteps: 1,
        client: {
          id: 'scripted',
          listModels: () => Effect.succeed([]),
          complete: (request) => {
            asks++
            return Effect.succeed({
              text: null,
              toolCalls: [],
              raw: {},
              requestId: request.requestId,
            })
          },
        },
      }),
    )

    expect(asks).toBe(2)
    expect(kinds(store).filter((k) => k === 'EmptyResponseRetried')).toHaveLength(1)
  })

  it('distinguishes an empty response with no reasoning from a silent thinker', async () => {
    const { deps } = await build()
    const turn = await Effect.runPromise(
      runTurn(asTurnId('turn_1'), [], 'anything', {
        ...deps,
        client: {
          id: 'scripted',
          listModels: () => Effect.succeed([]),
          complete: (request) =>
            Effect.succeed({
              text: null,
              toolCalls: [],
              raw: {},
              requestId: request.requestId,
            }),
        },
      }),
    )

    expect(turn.errorTag).toBe('EmptyModelResponse')
    expect(turn.errorMessage).toContain('neither text nor a tool call')
  })

  it('produces the same trace shape on every run, given the same input', async () => {
    const first = await build()
    await Effect.runPromise(runTurn(asTurnId('turn_1'), [], 'add milk', first.deps))
    const second = await build()
    await Effect.runPromise(runTurn(asTurnId('turn_1'), [], 'add milk', second.deps))

    expect(kinds(first.store)).toEqual(kinds(second.store))
  })
})
