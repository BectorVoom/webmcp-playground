import { describe, expect, it, vi } from 'vitest'
import { createTraceStore } from './memory-store'
import { asSessionId } from '../../domain/ids'

const store = () => createTraceStore(asSessionId('sess_test'), 3)

describe('createTraceStore', () => {
  it('assigns monotonic sequence numbers and the session id', () => {
    const s = store()
    s.append({ kind: 'TurnCancelled' })
    s.append({ kind: 'TurnCancelled' })
    expect(s.snapshot().map((e) => e.seq)).toEqual([1, 2])
    expect(s.snapshot()[0]?.sessionId).toBe('sess_test')
  })

  it('carries correlation through to the event', () => {
    const s = store()
    s.append({ kind: 'ToolCallStarted', tool: 'echo', input: {} }, { turnId: 'turn_1' as never })
    expect(s.snapshot()[0]?.turnId).toBe('turn_1')
  })

  it('drops the oldest events past the cap and counts the loss', () => {
    const s = store()
    for (let i = 0; i < 5; i++) s.append({ kind: 'TurnCancelled' })
    expect(s.snapshot()).toHaveLength(3)
    expect(s.snapshot().map((e) => e.seq)).toEqual([3, 4, 5])
    expect(s.discardedCount()).toBe(2)
  })

  it('returns a new snapshot identity per append, so external stores re-render once', () => {
    const s = store()
    const before = s.snapshot()
    s.append({ kind: 'TurnCancelled' })
    expect(s.snapshot()).not.toBe(before)
    expect(s.snapshot()).toBe(s.snapshot())
  })

  it('notifies and can be unsubscribed', () => {
    const s = store()
    const listener = vi.fn()
    const off = s.subscribe(listener)
    s.append({ kind: 'TurnCancelled' })
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    s.append({ kind: 'TurnCancelled' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('resets sequence and discard count on clear', () => {
    const s = store()
    for (let i = 0; i < 5; i++) s.append({ kind: 'TurnCancelled' })
    s.clear()
    expect(s.snapshot()).toHaveLength(0)
    expect(s.discardedCount()).toBe(0)
    s.append({ kind: 'TurnCancelled' })
    expect(s.snapshot()[0]?.seq).toBe(1)
  })
})
