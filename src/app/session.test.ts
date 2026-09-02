import { describe, expect, it, beforeEach } from 'vitest'
import { createSession } from './session'

/**
 * Session-level behaviour that spans the loop, the registry and the transcript
 * — chiefly turn retry (R1.7), which rewinds the conversation so the retried
 * turn sees the same history the original did.
 */
beforeEach(() => {
  history.replaceState(null, '', '/')
  globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch
})

const build = async (search = '') => {
  history.replaceState(null, '', `/${search}`)
  const session = createSession()
  await session.start()
  return session
}

describe('turn retry (R1.7)', () => {
  it('replays a step-limited turn from its originating user message', async () => {
    const session = await build('?toolSets=diagnostics&maxSteps=2')

    const first = await session.sendMessage('loop forever')
    expect(first.state).toBe('step_limit_exceeded')
    expect(session.state.snapshot().turns).toHaveLength(1)

    const retried = await session.retryTurn(first.id)

    expect(retried?.userMessage).toBe('loop forever')
    // The failed attempt is replaced, not appended to — otherwise a retry would
    // leave the transcript claiming the user asked twice.
    expect(session.state.snapshot().turns).toHaveLength(1)
    expect(session.state.snapshot().turns[0]?.id).toBe(retried?.id)
  })

  it('drops any turns that followed the one being retried', async () => {
    const session = await build('?toolSets=todo')

    const first = await session.sendMessage('add milk')
    await session.sendMessage('add bread')
    expect(session.state.snapshot().turns).toHaveLength(2)

    await session.retryTurn(first.id)

    const turns = session.state.snapshot().turns
    expect(turns).toHaveLength(1)
    expect(turns[0]?.userMessage).toBe('add milk')
  })

  it('returns undefined for a turn that is not in the transcript', async () => {
    const session = await build()
    expect(await session.retryTurn('turn_999' as never)).toBeUndefined()
  })
})

describe('correlation ids are per session (R5.1)', () => {
  it('numbers each session from turn_1, even when two share a document', async () => {
    const first = await build('?toolSets=todo')
    const second = await build('?toolSets=todo')

    const a = await first.sendMessage('add milk')
    const b = await second.sendMessage('add milk')

    expect(a.id).toBe('turn_1')
    // The point of the fix: the second session does not continue the first's
    // sequence, so its trace reads on its own terms.
    expect(b.id).toBe('turn_1')
    expect(a.toolCalls.map((c) => c.callId)).toEqual(b.toolCalls.map((c) => c.callId))
  })

  it('restarts the sequence on reset', async () => {
    const session = await build('?toolSets=todo')
    await session.sendMessage('add milk')

    await session.reset()

    expect((await session.sendMessage('add milk')).id).toBe('turn_1')
  })
})

describe('configuration in the URL (R2.8)', () => {
  it('restores the tool set selection from the query string on load', async () => {
    const session = await build('?toolSets=forms')
    expect(session.manager.enabledIds()).toEqual(['forms'])
  })

  it('writes the selection back so the link reproduces the configuration', async () => {
    const session = await build()
    await session.setToolSets(['forms', 'todo'])
    expect(location.search).toContain('toolSets=forms%2Ctodo')
  })

  it('honours a forced adapter from the URL', async () => {
    const session = await build('?adapter=legacy-navigator')
    expect(session.state.snapshot().adapterId).toBe('legacy-navigator')
    expect(session.state.snapshot().detection.overridden).toBe(true)
  })
})

describe('host change stream (R2.5)', () => {
  it('records the enabled tools after the session starts consuming host changes', async () => {
    const session = await build('?toolSets=todo')

    expect(
      session.traceStore
        .snapshot()
        .some(
          (event) =>
            event.payload.kind === 'ToolChanged' && event.payload.tools.includes('todo.add'),
        ),
    ).toBe(true)
  })
})

describe('adapter switching', () => {
  it('carries the live tool sets across a host switch and keeps the trace continuous', async () => {
    const session = await build('?toolSets=todo')
    const before = session.traceStore.snapshot().length

    await session.setAdapter('legacy-navigator')

    const tools = await session.runtime.runPromise(session.host().listTools())
    expect(session.state.snapshot().adapterId).toBe('legacy-navigator')
    expect(tools.map((tool) => tool.name)).toContain('todo.add')
    // The trace is not torn down with the host — that is why the host lives
    // outside the runtime layer (design §2, runtime.ts).
    expect(session.traceStore.snapshot().length).toBeGreaterThan(before)
  })
})
