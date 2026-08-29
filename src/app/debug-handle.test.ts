import { describe, expect, it, beforeEach } from 'vitest'
import { createSession } from './session'
import { createDebugHandle } from './debug-handle'

/**
 * The acceptance test for the project's stated top priority (checkpoint 8): an
 * agent seeds a failure, drives the page with no UI, and finds the one event
 * that explains it — no screenshot, no DOM scraping.
 */
const build = async () => {
  const session = createSession()
  await session.start()
  return { session, d: createDebugHandle(session) }
}

beforeEach(() => {
  // The session probes /api/health at startup; jsdom has no server, and the
  // scripted-driver fallback is exactly what should happen (R4.4).
  globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch
})

describe('window.__WEBMCP_DEBUG__', () => {
  it('falls back to the scripted driver and says why, rather than failing later', async () => {
    const { d } = await build()
    const state = d.getState()
    expect(state.driverId).toBe('scripted')
    expect(state.notice).toContain('scripted driver')
  })

  it('reports the active adapter with its spec revision and the detection reasoning', async () => {
    const { d } = await build()
    const adapter = d.getAdapter()
    expect(adapter.id).toBe('in-memory')
    expect(adapter.specRevision.length).toBeGreaterThan(0)
    expect(adapter.detection.candidates.length).toBe(3)
  })

  it('lists the tools the host actually holds', async () => {
    const { d } = await build()
    await d.setToolSets(['todo'])
    expect((await d.getTools()).map((t) => t.name)).toContain('todo.add')
  })

  it('invokes a tool with the model bypassed entirely', async () => {
    const { d } = await build()
    await d.setToolSets(['todo'])
    const result = await d.callTool('todo.add', { text: 'milk' })
    expect(result.content[0]?.text).toContain('milk')
  })

  it('drives a whole turn and settles', async () => {
    const { d } = await build()
    await d.setToolSets(['todo'])
    const turn = await d.sendMessage('add milk')
    await d.waitForIdle()
    expect(turn.state).toBe('completed')
    expect(d.getState().status).toBe('idle')
  })

  it('lets an agent seed a fault and find the event that explains it', async () => {
    const { d } = await build()
    await d.setToolSets(['diagnostics'])
    d.injectFault({ kind: 'fail', count: 1 })

    const turn = await d.sendMessage('echo hello')

    const failure = d
      .getTrace({ turnId: turn.id, kinds: ['ToolCallFailed'] })
      .at(0)
    expect(failure).toBeDefined()
    expect(failure?.payload).toMatchObject({ kind: 'ToolCallFailed', tool: 'debug.echo' })
    // The injected cause is in the trace too, so the diagnosis is complete.
    expect(d.getTrace({ turnId: turn.id, kinds: ['FaultInjected'] })).toHaveLength(1)
  })

  it('filters the trace by turn and by kind', async () => {
    const { d } = await build()
    await d.setToolSets(['todo'])
    const first = await d.sendMessage('add milk')
    const second = await d.sendMessage('add bread')

    const firstOnly = d.getTrace({ turnId: first.id })
    expect(firstOnly.every((e) => e.turnId === first.id)).toBe(true)
    expect(d.getTrace({ turnId: second.id }).length).toBeGreaterThan(0)
    expect(
      d.getTrace({ kinds: ['ModelRequested'] }).every((e) => e.payload.kind === 'ModelRequested'),
    ).toBe(true)
  })

  it('round-trips a trace through export and import', async () => {
    const { d } = await build()
    await d.setToolSets(['todo'])
    await d.sendMessage('add milk')
    const exported = d.exportTrace()

    const second = await build()
    expect(second.d.importTrace(exported)).toBe(true)
    expect(second.d.getState().imported).toBe(true)
    expect(second.d.getState().turns[0]?.userMessage).toBe('add milk')
    expect(second.d.getState().turns[0]?.toolCalls[0]?.name).toBe('todo.add')
  })

  it('refuses a file that is not a trace export', async () => {
    const { d } = await build()
    expect(d.importTrace({ nope: true })).toBe(false)
    expect(d.getState().imported).toBe(false)
  })

  it('documents the scripted scenarios in help(), so an agent need not read the source', async () => {
    const { d } = await build()
    expect(d.help()).toContain('callTool')
    expect(d.help()).toContain('loop')
  })

  it('clears transcript and trace on reset', async () => {
    const { d } = await build()
    await d.setToolSets(['todo'])
    await d.sendMessage('add milk')
    await d.reset()

    expect(d.getState().turns).toHaveLength(0)
    // The conversation is gone; the re-registration of the enabled tool sets is
    // not — reset leaves a usable session, not an empty one.
    expect(d.getTrace({ kinds: ['TurnStarted', 'ModelRequested'] })).toHaveLength(0)
    expect(d.getTrace({ kinds: ['ToolRegistered'] }).length).toBeGreaterThan(0)
  })
})

describe('framework overhead (N1)', () => {
  it('adds under 5 ms per trivial tool call', async () => {
    const { d } = await build()
    await d.setToolSets(['diagnostics'])

    // Warm up, so the first-call cost of schema compilation is not measured as
    // per-call overhead.
    for (let i = 0; i < 20; i++) await d.callTool('debug.echo', { text: 'x' })

    const started = performance.now()
    const iterations = 100
    for (let i = 0; i < iterations; i++) await d.callTool('debug.echo', { text: 'x' })
    const perCall = (performance.now() - started) / iterations

    expect(perCall).toBeLessThan(5)
  })
})
