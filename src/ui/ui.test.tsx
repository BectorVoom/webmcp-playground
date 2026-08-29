import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { createSession, type Session } from '../app/session'
import { resetIdCounters } from '../domain/ids'

/**
 * Component-level coverage for the three panes (task 7.14). Everything is
 * driven through the real session against the in-memory host and the scripted
 * driver, so these tests exercise the same code path the browser does.
 */
const setup = async (): Promise<Session> => {
  const session = createSession()
  await session.start()
  render(<App session={session} />)
  return session
}

beforeEach(() => {
  // Turn and call ids are monotonic per module, not per session, so they must be
  // reset or the second test in a file is looking for turn_2.
  resetIdCounters()
  // Configuration lives in the URL by design (R2.8), and jsdom keeps one
  // document for the whole file — so without this, a tool set disabled in one
  // test is still disabled in the next.
  history.replaceState(null, '', '/')
  globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch
})

describe('status bar', () => {
  it('reports adapter, driver, tool count and turn state at a glance (R5.12)', async () => {
    await setup()
    expect(screen.getByTestId('status-adapter')).toHaveTextContent('in-memory')
    expect(screen.getByTestId('status-driver')).toHaveTextContent('scripted')
    expect(screen.getByTestId('status-turn')).toHaveTextContent('idle')
    await waitFor(() =>
      expect(Number(screen.getByTestId('status-tools').textContent?.replace(/\D/g, ''))).toBeGreaterThan(0),
    )
  })
})

describe('selector pane', () => {
  it('lists every tool set with its tool count', async () => {
    await setup()
    expect(screen.getByTestId('selector-toolset-toggle-todo')).toBeChecked()
    expect(screen.getByTestId('selector-toolset-toggle-forms')).not.toBeChecked()
  })

  it('registers a set on toggle and shows the tools read back from the host', async () => {
    await setup()
    await userEvent.click(screen.getByTestId('selector-toolset-toggle-forms'))

    await waitFor(() =>
      expect(within(screen.getByTestId('selector-host-tools')).getByText('form.submit_contact')).toBeInTheDocument(),
    )
  })

  it('unregisters a set on untoggle', async () => {
    const session = await setup()
    await userEvent.click(screen.getByTestId('selector-toolset-toggle-todo'))
    await waitFor(() => expect(session.manager.enabledIds()).not.toContain('todo'))
  })

  it('explains why each adapter candidate was or was not selected (R6.3)', async () => {
    await setup()
    expect(screen.getByTestId('selector-detection-draft-2026-04')).toHaveTextContent(
      'not implemented',
    )
    expect(screen.getByTestId('selector-detection-in-memory')).toHaveTextContent('always available')
  })

  it('exposes the published JSON schema for a registered tool (R2.7)', async () => {
    await setup()
    await waitFor(() => screen.getByTestId('selector-schema-todo.add-toggle'))
    await userEvent.click(screen.getByTestId('selector-schema-todo.add-toggle'))
    expect(screen.getByTestId('selector-schema-todo.add')).toHaveTextContent('"type": "object"')
  })
})

describe('chat pane', () => {
  it('renders a turn with inline tool calls, durations and results (R1.6)', async () => {
    await setup()
    await userEvent.type(screen.getByTestId('chat-input-message'), 'add milk')
    await userEvent.click(screen.getByTestId('chat-button-send'))

    await waitFor(() => expect(screen.getByTestId('chat-turn-turn_1')).toBeInTheDocument())
    const turn = screen.getByTestId('chat-turn-turn_1')
    expect(turn).toHaveTextContent('todo.add')
    expect(turn).toHaveTextContent('todo.list')
    expect(turn).toHaveTextContent('ms')
    expect(screen.getByTestId('chat-turn-state-turn_1')).toHaveTextContent('completed')
  })

  it('disables sending until there is something to send', async () => {
    await setup()
    expect(screen.getByTestId('chat-button-send')).toBeDisabled()
    await userEvent.type(screen.getByTestId('chat-input-message'), 'hi')
    expect(screen.getByTestId('chat-button-send')).toBeEnabled()
  })

  it('shows a tool failure with its tag and message rather than an opaque object (R5.13)', async () => {
    await setup()
    // `diagnostics` is enabled by default, so debug.fail is already registered.
    await userEvent.type(screen.getByTestId('chat-input-message'), 'please fail')
    await userEvent.click(screen.getByTestId('chat-button-send'))

    await waitFor(() => expect(screen.getByTestId('chat-turn-turn_1')).toBeInTheDocument())
    const turn = screen.getByTestId('chat-turn-turn_1')
    expect(turn).toHaveTextContent('ToolExecutionError')
    expect(turn).not.toHaveTextContent('[object Object]')
  })

  it('names the tools that DO exist when the model calls one that does not', async () => {
    await setup()
    await userEvent.click(screen.getByTestId('selector-toolset-toggle-diagnostics'))
    await userEvent.type(screen.getByTestId('chat-input-message'), 'please fail')
    await userEvent.click(screen.getByTestId('chat-button-send'))

    await waitFor(() => expect(screen.getByTestId('chat-turn-turn_1')).toBeInTheDocument())
    const turn = screen.getByTestId('chat-turn-turn_1')
    expect(turn).toHaveTextContent('ToolNotFound')
    // Listing what IS registered turns a dead end into a diagnosis.
    expect(turn).toHaveTextContent('todo.add')
  })

  it('announces the transcript as a live region for assistive technology (N3)', async () => {
    await setup()
    expect(screen.getByTestId('chat-transcript')).toHaveAttribute('aria-live', 'polite')
  })

  it('tells the user plainly that no local LLM was reachable (R4.4)', async () => {
    await setup()
    expect(screen.getByTestId('chat-notice')).toHaveTextContent('scripted driver')
  })
})

describe('inspector pane', () => {
  it('shows trace events with sequence numbers and summaries', async () => {
    await setup()
    await waitFor(() => expect(screen.getByTestId('inspector-events')).toHaveTextContent('AdapterSelected'))
    expect(screen.getByTestId('inspector-count')).toHaveTextContent('total')
  })

  it('filters by category', async () => {
    await setup()
    await userEvent.type(screen.getByTestId('chat-input-message'), 'add milk')
    await userEvent.click(screen.getByTestId('chat-button-send'))
    await waitFor(() => expect(screen.getByTestId('chat-turn-turn_1')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('inspector-filter-model'))
    const events = screen.getByTestId('inspector-events')
    expect(events).toHaveTextContent('ModelRequested')
    expect(events).not.toHaveTextContent('ToolRegistered')
  })

  it('exposes the verbatim JSON of an event (R5.3)', async () => {
    await setup()
    await waitFor(() => screen.getByTestId('inspector-json-1-toggle'))
    await userEvent.click(screen.getByTestId('inspector-json-1-toggle'))
    expect(screen.getByTestId('inspector-json-1')).toHaveTextContent('"sessionId"')
  })
})
