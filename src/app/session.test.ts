import { describe, expect, it, beforeEach } from 'vitest'
import { createSession } from './session'
import { resetIdCounters } from '../domain/ids'

/**
 * Session-level behaviour that spans the loop, the registry and the transcript
 * — chiefly turn retry (R1.7), which rewinds the conversation so the retried
 * turn sees the same history the original did.
 */
beforeEach(() => {
  resetIdCounters()
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
