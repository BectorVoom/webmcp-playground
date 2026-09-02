import { describe, expect, it } from 'vitest'
import { Effect, Fiber, Schema, Stream } from 'effect'
import { createTraceStore } from '../trace/memory-store'
import { makeMemorySink } from '../trace/memory-sink'
import { asSessionId, createIdFactory } from '../../domain/ids'
import { textResult, type AnyToolDefinition } from '../../domain/tool'
import { ToolExecutionError } from '../../domain/errors'
import { createFaultInjector } from '../../app/fault-injector'
import { createToolRunner } from '../../app/tool-runner'
import type { ToolHostService } from '../../ports/ToolHost'
import { makeInMemoryHost } from './in-memory'
import { makeDraftHost } from './draft-2026-04'
import { makeLegacyHost } from './legacy-navigator'
import { createFakeDraftHost, createFakeLegacyHost } from './__fixtures__/fake-hosts'

/**
 * THE conformance suite (R6.5).
 *
 * Written against ToolHostPort and parameterised over every adapter, so a new
 * WebMCP revision is proven equivalent before it can be selected. It is
 * deliberately the first thing that was written in this phase: a suite authored
 * after the adapters would only describe what those adapters happen to do,
 * whereas this one describes what any host must do.
 */

const echoTool: AnyToolDefinition = {
  name: 'echo',
  description: 'Echoes its input back.',
  inputSchema: Schema.Struct({ text: Schema.String }),
  annotations: { readOnlyHint: true, untrustedContentHint: false },
  execute: (input: { text: string }) => Effect.succeed(textResult(input.text)),
}

const failingTool: AnyToolDefinition = {
  ...echoTool,
  name: 'always-fails',
  description: 'Always fails.',
  execute: () =>
    Effect.fail(new ToolExecutionError({ tool: 'always-fails', message: 'boom' })),
}

const hangingTool: AnyToolDefinition = {
  ...echoTool,
  name: 'hangs',
  description: 'Never settles.',
  execute: () => Effect.never,
}

interface AdapterCase {
  readonly id: string
  readonly make: () => { host: ToolHostService; store: ReturnType<typeof createTraceStore> }
  readonly supportsCancellation: boolean
}

const buildDeps = () => {
  const store = createTraceStore(asSessionId('sess_conf'))
  const sink = makeMemorySink(store)
  const runner = createToolRunner({
    sink,
    faults: createFaultInjector(),
    ids: createIdFactory(),
    timeoutMs: () => 1000,
    currentTurnId: () => undefined,
  })
  return { store, sink, runner }
}

const cases: ReadonlyArray<AdapterCase> = [
  {
    id: 'in-memory',
    make: () => {
      const { store, sink, runner } = buildDeps()
      return { host: makeInMemoryHost(runner, sink), store }
    },
    supportsCancellation: true,
  },
  {
    id: 'draft-2026-04 (spec-shaped fake)',
    make: () => {
      const { store, sink, runner } = buildDeps()
      return { host: makeDraftHost(createFakeDraftHost(), runner, sink), store }
    },
    supportsCancellation: true,
  },
  {
    id: 'draft-2026-04 (current object-input draft)',
    make: () => {
      const { store, sink, runner } = buildDeps()
      return {
        host: makeDraftHost(createFakeDraftHost({ executeInput: 'object' }), runner, sink),
        store,
      }
    },
    supportsCancellation: true,
  },
  {
    id: 'draft-2026-04 (lossy host)',
    make: () => {
      const { store, sink, runner } = buildDeps()
      return {
        host: makeDraftHost(createFakeDraftHost({ lossyErrors: true }), runner, sink),
        store,
      }
    },
    // The host flattens rejected promises. The adapter fulfils typed failures
    // as an `isError` result, so this remains a precise local error.
    supportsCancellation: true,
  },
  {
    // Calibrated against Chrome 152 and Edge 151 as measured, not as the prose
    // reads: they flatten every rejection to a DOMException and hand the tool
    // body no options argument at all. This case is what shipping browsers do,
    // so a change that only satisfies the optimistic fake above fails here.
    id: 'draft-2026-04 (browser-shaped: no signal, DOMException errors)',
    make: () => {
      const { store, sink, runner } = buildDeps()
      return {
        host: makeDraftHost(
          createFakeDraftHost({ lossyErrors: true, forwardsSignal: false }),
          runner,
          sink,
        ),
        store,
      }
    },
    // A host that forwards no signal cannot cancel a running tool through the
    // boundary. The per-call timeout is what stops a hung tool there.
    supportsCancellation: false,
  },
  {
    id: 'legacy-navigator',
    make: () => {
      const { store, sink, runner } = buildDeps()
      return { host: makeLegacyHost(createFakeLegacyHost(), runner, sink), store }
    },
    supportsCancellation: true,
  },
  {
    id: 'legacy-navigator (with readback)',
    make: () => {
      const { store, sink, runner } = buildDeps()
      return {
        host: makeLegacyHost(createFakeLegacyHost({ withReadback: true }), runner, sink),
        store,
      }
    },
    supportsCancellation: true,
  },
]

/**
 * Adapters against the REAL browser API, skipped loudly rather than silently.
 *
 * jsdom has no `document.modelContext` and never will, so this slot stays
 * skipped here by construction. The coverage it stands for is not missing,
 * though: `bun tools/browser-verify.ts` drives the built app against Chrome's
 * and Edge's real implementations, and the browser-shaped fake above is
 * calibrated against what those measurably do.
 */
const realHostAvailability = (): ReadonlyArray<{ id: string; reason: string }> => [
  {
    id: 'draft-2026-04 (real document.modelContext)',
    reason:
      typeof document !== 'undefined' && 'modelContext' in document
        ? 'available'
        : 'document.modelContext is absent in jsdom — run `bun tools/browser-verify.ts` for real-host coverage',
  },
]

describe.each(cases)('ToolHostPort conformance — $id', ({ make, supportsCancellation }) => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

  it('registers a tool and reads it back from the host', async () => {
    const { host } = make()
    await run(host.register(echoTool))
    const tools = await run(host.listTools())
    expect(tools.map((t) => t.name)).toEqual(['echo'])
  })

  it('publishes the derived JSON Schema to the host', async () => {
    const { host } = make()
    await run(host.register(echoTool))
    const [tool] = await run(host.listTools())
    expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['text'] })
  })

  it('rejects a name the spec does not allow', async () => {
    const { host } = make()
    const error = await run(Effect.flip(host.register({ ...echoTool, name: 'has space' })))
    expect(error._tag).toBe('ToolRegistrationError')
  })

  it('rejects an empty description', async () => {
    const { host } = make()
    const error = await run(Effect.flip(host.register({ ...echoTool, description: '  ' })))
    expect(error._tag).toBe('ToolRegistrationError')
  })

  it('rejects a duplicate name and preserves the host message', async () => {
    const { host } = make()
    await run(host.register(echoTool))
    const error = await run(Effect.flip(host.register(echoTool)))
    expect(error._tag).toBe('ToolRegistrationError')
    // Verbatim from the host, whichever words it chose — our in-memory hosts
    // say "already registered", Chrome and Edge say "Duplicate tool name". The
    // property under test is that the host's own message survives (R6.8).
    expect(error.hostMessage).toMatch(/duplicate|already registered/i)
  })

  it('executes a registered tool and returns content blocks', async () => {
    const { host } = make()
    await run(host.register(echoTool))
    const result = await run(
      host.execute('echo', { text: 'hello' }, { signal: new AbortController().signal }),
    )
    expect(result.content[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('fails with ToolNotFound for an unknown tool', async () => {
    const { host } = make()
    await run(host.register(echoTool))
    const error = await run(
      Effect.flip(host.execute('nope', {}, { signal: new AbortController().signal })),
    )
    expect(error._tag).toBe('ToolNotFound')
  })

  it('rejects input that does not satisfy the schema, without running the body', async () => {
    const { host, store } = make()
    await run(host.register(echoTool))
    const error = await run(
      Effect.flip(host.execute('echo', { text: 42 }, { signal: new AbortController().signal })),
    )
    expect(error._tag).toBe('ToolInputInvalid')
    expect(store.snapshot().some((e) => e.payload.kind === 'ToolCallCompleted')).toBe(false)
  })

  it('surfaces a failing tool body as an error, not a result', async () => {
    const { host } = make()
    await run(host.register(failingTool))
    const error = await run(
      Effect.flip(host.execute('always-fails', { text: 'x' }, { signal: new AbortController().signal })),
    )
    expect(error._tag).toBe('ToolExecutionError')
  })

  it.runIf(supportsCancellation)('aborts a running tool when the signal fires', async () => {
    const { host } = make()
    await run(host.register(hangingTool))
    const controller = new AbortController()
    const promise = Effect.runPromise(
      Effect.flip(host.execute('hangs', { text: 'x' }, { signal: controller.signal })),
    )
    controller.abort()
    const error = await promise
    expect(error._tag).toBe('ToolAborted')
  })

  it('removes the tool from the host when the registration is unregistered', async () => {
    const { host } = make()
    const handle = await run(host.register(echoTool))
    await run(handle.unregister)
    const tools = await run(host.listTools())
    expect(tools.map((t) => t.name)).not.toContain('echo')
  })

  it('emits tool-set changes and releases its host listener when interrupted', async () => {
    const { host } = make()
    let changes = 0
    const fiber = Effect.runFork(
      Stream.runForEach(host.changes, () =>
        Effect.sync(() => {
          changes += 1
        }),
      ),
    )
    await run(Effect.yieldNow())
    await run(host.register(echoTool))
    await run(Effect.yieldNow())
    expect(changes).toBe(1)
    await run(Fiber.interrupt(fiber))
    await run(host.register({ ...echoTool, name: 'echo2' }))
    await run(Effect.yieldNow())
    expect(changes).toBe(1)
  })

  it('reports a spec revision, so the UI can say which draft is live', () => {
    const { host } = make()
    expect(host.specRevision.label.length).toBeGreaterThan(0)
    expect(host.specRevision.url).toMatch(/^https:\/\//)
  })

  it('traces every registration with the schema that was published', async () => {
    const { host, store } = make()
    await run(host.register(echoTool))
    const event = store.snapshot().find((e) => e.payload.kind === 'ToolRegistered')
    expect(event?.payload).toMatchObject({ kind: 'ToolRegistered', tool: 'echo' })
  })
})

describe('real browser hosts', () => {
  for (const { id, reason } of realHostAvailability()) {
    // Never a silent skip: an adapter that is not exercised says so, with why.
    it.skipIf(reason !== 'available')(`${id} — ${reason}`, () => {
      expect(reason).toBe('available')
    })
  }
})
