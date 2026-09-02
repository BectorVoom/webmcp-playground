import { describe, expect, it } from 'vitest'
import { Effect, Schema } from 'effect'
import { createTraceStore } from '../adapters/trace/memory-store'
import { makeMemorySink } from '../adapters/trace/memory-sink'
import { makeInMemoryHost } from '../adapters/webmcp/in-memory'
import { asSessionId, createIdFactory } from '../domain/ids'
import { textResult, type ToolSet } from '../domain/tool'
import { createFaultInjector } from './fault-injector'
import { createToolRunner } from './tool-runner'
import { createToolRegistryManager } from './tool-registry'
import { TOOL_SETS } from '../toolsets'

const tool = (name: string) => ({
  name,
  description: `Tool ${name}`,
  inputSchema: Schema.Struct({}),
  annotations: { readOnlyHint: true, untrustedContentHint: false },
  execute: () => Effect.succeed(textResult('ok')),
})

const setA: ToolSet = { id: 'a', title: 'A', description: 'a', tools: [tool('x'), tool('y')] }
const setB: ToolSet = { id: 'b', title: 'B', description: 'b', tools: [tool('z')] }
const setClash: ToolSet = { id: 'clash', title: 'C', description: 'c', tools: [tool('x')] }

const build = (catalogue: ReadonlyArray<ToolSet>) => {
  const store = createTraceStore(asSessionId('sess_reg'))
  const sink = makeMemorySink(store)
  const runner = createToolRunner({
    sink,
    faults: createFaultInjector(),
    ids: createIdFactory(),
    timeoutMs: () => 1000,
    currentTurnId: () => undefined,
  })
  const host = makeInMemoryHost(runner, sink)
  return { store, host, manager: createToolRegistryManager(catalogue, host, sink) }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe('tool registry manager', () => {
  it('registers every tool in an enabled set', async () => {
    const { manager, host } = build([setA, setB])
    await run(manager.enable('a'))
    expect((await run(host.listTools())).map((t) => t.name)).toEqual(['x', 'y'])
  })

  it('unregisters the whole set on disable', async () => {
    const { manager, host } = build([setA, setB])
    await run(manager.enable('a'))
    await run(manager.disable('a'))
    expect(await run(host.listTools())).toHaveLength(0)
  })

  it('refuses a set that would duplicate a name, naming both owners', async () => {
    const { manager } = build([setA, setClash])
    await run(manager.enable('a'))
    const error = await run(Effect.flip(manager.enable('clash')))
    expect(error._tag).toBe('DuplicateToolName')
    expect(error.tool).toBe('x')
    expect(error.owningSets).toEqual(['a', 'clash'])
  })

  it('leaves the host untouched when it refuses a clashing set', async () => {
    const { manager, host } = build([setA, setClash])
    await run(manager.enable('a'))
    await run(Effect.ignore(manager.enable('clash')))
    expect((await run(host.listTools())).map((t) => t.name)).toEqual(['x', 'y'])
  })

  it('reconciles to exactly the requested selection', async () => {
    const { manager, host } = build([setA, setB])
    await run(manager.setEnabled(['a']))
    await run(manager.setEnabled(['b']))
    expect((await run(host.listTools())).map((t) => t.name)).toEqual(['z'])
    expect(manager.enabledIds()).toEqual(['b'])
  })

  it('moves live registrations to a new host on rebind, leaving none behind', async () => {
    const { manager, host } = build([setA])
    await run(manager.enable('a'))

    const store = createTraceStore(asSessionId('sess_next'))
    const sink = makeMemorySink(store)
    const runner = createToolRunner({
      sink,
      faults: createFaultInjector(),
      ids: createIdFactory(),
      timeoutMs: () => 1000,
      currentTurnId: () => undefined,
    })
    const nextHost = makeInMemoryHost(runner, sink)

    await run(manager.rebindHost(nextHost))
    expect(await run(host.listTools())).toHaveLength(0)
    expect((await run(nextHost.listTools())).map((t) => t.name)).toEqual(['x', 'y'])
  })

  it('reports per-tool registration outcomes for the selector to render', async () => {
    const { manager } = build([setA])
    await run(manager.enable('a'))
    const status = manager.status.snapshot().find((s) => s.id === 'a')
    expect(status?.enabled).toBe(true)
    expect(status?.tools).toEqual([
      { name: 'x', status: 'registered' },
      { name: 'y', status: 'registered' },
    ])
  })
})

describe('shipped tool sets', () => {
  it('registers every shipped set without a name collision', async () => {
    const { manager, host } = build(TOOL_SETS)
    await run(manager.setEnabled(TOOL_SETS.map((s) => s.id)))
    const registered = await run(host.listTools())
    expect(registered).toHaveLength(TOOL_SETS.reduce((n, s) => n + s.tools.length, 0))
  })

  it('propagates annotations to the host for every tool (R3.7)', async () => {
    const { manager, host } = build(TOOL_SETS)
    await run(manager.setEnabled(TOOL_SETS.map((s) => s.id)))
    for (const tool of await run(host.listTools())) {
      expect(tool.annotations).toBeDefined()
      expect(typeof tool.annotations?.readOnlyHint).toBe('boolean')
      expect(typeof tool.annotations?.untrustedContentHint).toBe('boolean')
    }
  })

  it('gives every shipped tool a spec-legal name and a non-empty description', () => {
    for (const set of TOOL_SETS) {
      for (const tool of set.tools) {
        expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/)
        expect(tool.description.trim().length).toBeGreaterThan(0)
      }
    }
  })
})
