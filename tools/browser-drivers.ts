/**
 * Three automation transports, one interface.
 *
 * Written against each browser's own protocol rather than a driver library on
 * purpose: the browsers are already installed, and the deferred-scope decision
 * on a Playwright suite (requirements §8) should not be re-litigated by the
 * back door just to answer "does this run in Firefox?". Nothing here is a test
 * framework — it navigates, evaluates, and collects console errors.
 *
 *   Chrome, Edge → Chrome DevTools Protocol over a WebSocket
 *   Firefox      → WebDriver BiDi over a WebSocket (Gecko dropped CDP)
 *   Safari       → W3C WebDriver over HTTP, via the safaridriver that ships
 *                  with macOS
 */
import { spawn, type Subprocess } from 'bun'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface BrowserSession {
  navigate: (url: string) => Promise<void>
  evaluate: <T>(expression: string) => Promise<T>
  /** Console errors and uncaught exceptions seen since the last navigate. */
  consoleErrors: () => ReadonlyArray<string>
  close: () => Promise<void>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (probe: () => Promise<boolean>, ms: number, what: string) => {
  const started = Date.now()
  for (;;) {
    if (await probe()) return
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(150)
  }
}

const randomPort = (base: number) => base + Math.floor(Math.random() * 800)

/** The slice of each protocol's event payloads this file actually reads. */
interface EventParams {
  readonly type?: string
  readonly level?: string
  readonly text?: string
  readonly args?: ReadonlyArray<{ readonly value?: unknown; readonly description?: string }>
  readonly exceptionDetails?: {
    readonly exception?: { readonly description?: string }
    readonly text?: string
  }
}

interface WebDriverValue {
  readonly error?: string
  readonly message?: string
  readonly sessionId?: string
}

/** A JSON-RPC-ish request/response multiplexer shared by the two socket protocols. */
const socketRpc = (ws: WebSocket) => {
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  const settle = (id: number, value: unknown, error?: Error) => {
    const slot = pending.get(id)
    pending.delete(id)
    if (error) slot?.reject(error)
    else slot?.resolve(value)
  }

  const send = <T>(payload: Record<string, unknown>): Promise<T> => {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      ws.send(JSON.stringify({ id, ...payload }))
    })
  }

  return { send, settle }
}

// ---------------------------------------------------------------- Chromium

export const launchChromium = async (
  binary: string,
  extraArgs: ReadonlyArray<string> = [],
): Promise<BrowserSession> => {
  const port = randomPort(9200)
  const profile = mkdtempSync(join(tmpdir(), 'webmcp-verify-'))
  const proc: Subprocess = spawn({
    cmd: [
      binary,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      '--use-mock-keychain',
      ...extraArgs,
      'about:blank',
    ],
    stdout: 'ignore',
    stderr: 'ignore',
  })

  const base = `http://127.0.0.1:${port}`
  await waitFor(
    async () => {
      try {
        return (await fetch(`${base}/json/version`)).ok
      } catch {
        return false
      }
    },
    30_000,
    'the devtools endpoint',
  )

  const targets = (await (await fetch(`${base}/json/list`)).json()) as Array<{
    type: string
    webSocketDebuggerUrl?: string
  }>
  const target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (target?.webSocketDebuggerUrl === undefined) throw new Error('no page target to attach to')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('devtools socket refused the connection'))
  })

  const { send, settle } = socketRpc(ws)
  const errors: string[] = []
  let loaded = false

  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number
      method?: string
      params?: EventParams
      result?: unknown
      error?: { message: string }
    }
    if (msg.id !== undefined) {
      settle(msg.id, msg.result, msg.error ? new Error(msg.error.message) : undefined)
      return
    }
    if (msg.method === 'Page.loadEventFired') loaded = true
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      errors.push(
        (msg.params.args ?? [])
          .map((arg) => String(arg.value ?? arg.description ?? ''))
          .join(' ')
          .trim(),
      )
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(
        msg.params?.exceptionDetails?.exception?.description ??
          msg.params?.exceptionDetails?.text ??
          'uncaught exception',
      )
    }
  }

  await send({ method: 'Page.enable', params: {} })
  await send({ method: 'Runtime.enable', params: {} })

  return {
    navigate: async (url) => {
      loaded = false
      errors.length = 0
      await send({ method: 'Page.navigate', params: { url } })
      await waitFor(async () => loaded, 45_000, `${url} to load`)
    },
    evaluate: async <T>(expression: string): Promise<T> => {
      const result = await send<{
        result: { value?: T }
        exceptionDetails?: { exception?: { description?: string }; text?: string }
      }>({
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      })
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            'evaluate threw',
        )
      }
      return result.result.value as T
    },
    consoleErrors: () => [...errors],
    close: async () => {
      try {
        ws.close()
      } catch {
        /* socket already gone */
      }
      proc.kill()
      await proc.exited
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

// ----------------------------------------------------------------- Firefox

export const launchFirefox = async (binary: string): Promise<BrowserSession> => {
  const port = randomPort(9300)
  const profile = mkdtempSync(join(tmpdir(), 'webmcp-ff-'))
  const proc: Subprocess = spawn({
    cmd: [binary, '--headless', `--remote-debugging-port=${port}`, '--profile', profile, 'about:blank'],
    stdout: 'ignore',
    stderr: 'ignore',
  })

  // BiDi answers on the bare port; there is no HTTP discovery document to poll,
  // so the readiness probe is the socket handshake itself.
  const openSocket = async (): Promise<WebSocket> => {
    const started = Date.now()
    for (;;) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/session`)
      const ok = await new Promise<boolean>((resolve) => {
        socket.onopen = () => resolve(true)
        socket.onerror = () => resolve(false)
        socket.onclose = () => resolve(false)
      })
      if (ok) return socket
      if (Date.now() - started > 60_000) throw new Error('Firefox never accepted a BiDi connection')
      await sleep(300)
    }
  }

  const ws = await openSocket()
  const { send, settle } = socketRpc(ws)
  const errors: string[] = []

  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number
      type?: string
      method?: string
      params?: EventParams
      result?: unknown
      error?: string
      message?: string
    }
    if (msg.id !== undefined && (msg.type === 'success' || msg.type === 'error')) {
      settle(
        msg.id,
        msg.result,
        msg.type === 'error' ? new Error(`${msg.error}: ${msg.message}`) : undefined,
      )
      return
    }
    if (msg.method === 'log.entryAdded' && msg.params?.level === 'error') {
      errors.push(String(msg.params?.text ?? 'error'))
    }
  }

  await send({ method: 'session.new', params: { capabilities: {} } })
  const tree = await send<{ contexts: Array<{ context: string }> }>({
    method: 'browsingContext.getTree',
    params: {},
  })
  const context = tree.contexts[0]?.context
  if (context === undefined) throw new Error('Firefox reported no browsing context')
  await send({ method: 'session.subscribe', params: { events: ['log.entryAdded'] } })

  return {
    navigate: async (url) => {
      errors.length = 0
      await send({ method: 'browsingContext.navigate', params: { context, url, wait: 'complete' } })
    },
    evaluate: async <T>(expression: string): Promise<T> => {
      const result = await send<{
        type: string
        result?: { value?: T }
        exceptionDetails?: { text?: string }
      }>({
        method: 'script.evaluate',
        params: { expression, target: { context }, awaitPromise: true, resultOwnership: 'none' },
      })
      if (result.type === 'exception') {
        throw new Error(result.exceptionDetails?.text ?? 'evaluate threw')
      }
      return result.result?.value as T
    },
    consoleErrors: () => [...errors],
    close: async () => {
      try {
        ws.close()
      } catch {
        /* socket already gone */
      }
      proc.kill()
      await proc.exited
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

// ------------------------------------------------------------------ Safari

export class SafariAutomationDisabled extends Error {}

export const launchSafari = async (): Promise<BrowserSession> => {
  const port = randomPort(4500)
  const proc: Subprocess = spawn({
    cmd: ['/usr/bin/safaridriver', '-p', String(port)],
    stdout: 'ignore',
    stderr: 'ignore',
  })

  const base = `http://127.0.0.1:${port}`
  await waitFor(
    async () => {
      try {
        return (await fetch(`${base}/status`)).ok
      } catch {
        return false
      }
    },
    20_000,
    'safaridriver',
  )

  const created = await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: 'safari' } } }),
  })
  const createdBody = (await created.json()) as { value?: WebDriverValue }
  const sessionId = createdBody.value?.sessionId
  if (sessionId === undefined) {
    proc.kill()
    await proc.exited
    const message = createdBody.value?.message ?? 'safaridriver refused to create a session'
    // Its own words: this is a one-time machine setting, not a code problem, and
    // no retry clears it.
    throw new SafariAutomationDisabled(message)
  }

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}/session/${sessionId}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const parsed = (await response.json()) as { value?: unknown }
    const failure = parsed.value as WebDriverValue | undefined
    if (failure?.error !== undefined) {
      throw new Error(`${failure.error}: ${failure.message ?? ''}`)
    }
    return parsed.value as T
  }

  return {
    navigate: async (url) => {
      await call('POST', '/url', { url })
    },
    // WebDriver has no console feed, so page errors are collected in-page by the
    // battery itself rather than reported here.
    evaluate: <T>(expression: string): Promise<T> =>
      call<T>('POST', '/execute/async', {
        script: `const done = arguments[arguments.length - 1];
                 (async () => { return (${expression}) })().then(v => done({ ok: true, v }), e => done({ ok: false, e: String(e && e.message || e) }))`,
        args: [],
      }).then((wrapped) => {
        const result = wrapped as unknown as { ok: boolean; v?: T; e?: string }
        if (!result.ok) throw new Error(result.e ?? 'evaluate threw')
        return result.v as T
      }),
    consoleErrors: () => [],
    close: async () => {
      try {
        await call('DELETE', '')
      } catch {
        /* session already gone */
      }
      proc.kill()
      await proc.exited
    },
  }
}
