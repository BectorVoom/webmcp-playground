/**
 * Cross-browser verification (tech-debt item 4, task 9.7).
 *
 * The conformance suite proves the adapters against fakes in jsdom. This proves
 * the built application against real browser engines — including, where the
 * browser has one, a real `document.modelContext` rather than our model of it.
 * That distinction is the whole point: every divergence recorded in
 * docs/browser-verification.md was invisible to a suite that only ever asked
 * our own fake.
 *
 *   bun run build
 *   PORT=8791 GEO_DATA_MODE=fixture bun run server/index.ts &
 *   bun tools/browser-verify.ts
 *
 * Exits non-zero if any check fails. A browser that is absent, or whose
 * automation is switched off at the machine level, is reported as SKIPPED with
 * the reason — never passed over in silence.
 */
import { existsSync } from 'node:fs'
import {
  launchChromium,
  launchFirefox,
  launchSafari,
  SafariAutomationDisabled,
  type BrowserSession,
} from './browser-drivers'

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:8791'

/** Chromium ships WebMCP behind this flag; without it the app must fall back. */
const EXPERIMENTAL = '--enable-experimental-web-platform-features'

interface Target {
  readonly label: string
  readonly open: () => Promise<BrowserSession>
  readonly available: () => string | true
  /** Which adapter the app must choose here, and why we believe that. */
  readonly expectAdapter: 'draft-2026-04' | 'in-memory'
  /**
   * Console output this browser produces on its own account. Reported as a
   * note rather than a failure, but never dropped — an allowance without a
   * stated cause is how a real regression gets waved through.
   */
  readonly knownConsoleNoise?: { readonly pattern: RegExp; readonly why: string }
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox'

const present = (path: string) => (): string | true =>
  existsSync(path) ? true : `${path} is not installed`

const TARGETS: ReadonlyArray<Target> = [
  {
    label: 'Chrome (stock)',
    open: () => launchChromium(CHROME),
    available: present(CHROME),
    expectAdapter: 'in-memory',
  },
  {
    label: `Chrome (${EXPERIMENTAL})`,
    open: () => launchChromium(CHROME, [EXPERIMENTAL]),
    available: present(CHROME),
    expectAdapter: 'draft-2026-04',
  },
  {
    label: 'Edge (stock)',
    open: () => launchChromium(EDGE),
    available: present(EDGE),
    expectAdapter: 'in-memory',
  },
  {
    label: `Edge (${EXPERIMENTAL})`,
    open: () => launchChromium(EDGE, [EXPERIMENTAL]),
    available: present(EDGE),
    expectAdapter: 'draft-2026-04',
  },
  {
    label: 'Firefox',
    open: () => launchFirefox(FIREFOX),
    available: present(FIREFOX),
    expectAdapter: 'in-memory',
  },
  {
    label: 'Safari',
    open: () => launchSafari(),
    available: () =>
      existsSync('/Applications/Safari.app') ? true : 'Safari is not installed',
    expectAdapter: 'in-memory',
  },
]

/**
 * The battery, as one expression evaluated in the page. It drives the app
 * through `window.__WEBMCP_DEBUG__` — the same surface a human uses from the
 * console — so it exercises the real composition root rather than a rebuilt
 * one, and returns findings rather than throwing on the first problem.
 */
const BATTERY = `(async () => {
  const checks = []
  const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail: detail === undefined ? null : String(detail).slice(0, 300) }) }
  const pageErrors = []
  addEventListener('error', (e) => pageErrors.push(String(e.message)))
  addEventListener('unhandledrejection', (e) => pageErrors.push('unhandled rejection: ' + String(e.reason && e.reason.message || e.reason)))

  const deadline = Date.now() + 20000
  while (!window.__WEBMCP_DEBUG__ && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  const d = window.__WEBMCP_DEBUG__
  check('the app boots and installs its debug handle', !!d)
  if (!d) return JSON.stringify({ checks, pageErrors, adapter: null })

  const webmcp = { document: 'modelContext' in document, navigator: 'modelContext' in navigator }
  const adapter = d.getAdapter()

  const candidates = adapter.detection.candidates
  check('detection reports every candidate with a reason',
    candidates.length === 3 && candidates.every(c => typeof c.reason === 'string' && c.reason.length > 0),
    JSON.stringify(candidates))

  await d.setToolSets(['todo', 'diagnostics'])
  const tools = await d.getTools()
  const names = tools.map(t => t.name)
  check('tools registered with the host are read back from it',
    names.includes('todo.add') && names.includes('todo.list') && names.includes('debug.fail'),
    names.join(','))

  // Guards the stringified-schema divergence: a schema published as a string
  // reaches the model as a string, and no endpoint can read that.
  const addSchema = tools.find(t => t.name === 'todo.add')?.inputSchema
  check('the published input schema is an object, not a JSON string',
    addSchema && typeof addSchema === 'object' && addSchema.type === 'object' && Array.isArray(addSchema.required) && addSchema.required.includes('text'),
    typeof addSchema + ' ' + JSON.stringify(addSchema))

  const added = await d.callTool('todo.add', { text: 'milk' })
  check('a tool executes through the host and returns content blocks',
    added && Array.isArray(added.content) && added.content[0] && added.content[0].type === 'text',
    JSON.stringify(added))

  const listed = await d.callTool('todo.list', {})
  check('tool state survives the round trip',
    JSON.stringify(listed).includes('milk'), JSON.stringify(listed))

  // This used to become the browser's generic UnknownError. The specific tag
  // proves that the fulfilled isError transport survived the real host.
  let invalidRejected = false
  try { await d.callTool('todo.add', { text: 42 }) } catch { invalidRejected = true }
  const invalidFailure = d.getTrace({ kinds: ['ToolCallFailed'] }).at(-1)
  const invalidTag = invalidFailure?.payload?.errorTag
  check('a structured input error survives the real host boundary',
    invalidRejected && invalidTag === 'ToolInputInvalid',
    invalidTag ?? 'no ToolCallFailed event')

  let unknownRejected = false
  try { await d.callTool('definitely.not.a.tool', {}) } catch { unknownRejected = true }
  check('an unknown tool is refused', unknownRejected)

  const turn = await d.sendMessage('add bread')
  check('a full turn completes through the real host',
    turn.state === 'completed' && turn.toolCalls.length > 0,
    turn.state + ' / ' + turn.toolCalls.map(c => c.name).join(','))

  // A failing tool must come back as a tagged record, not take the turn down.
  // Reset first: the scripted driver derives its step from the assistant turns
  // already in the history, so a second scenario in the same conversation would
  // start past its own last step and answer with prose instead of calling.
  await d.reset()
  await d.setToolSets(['todo', 'diagnostics'])
  const failed = await d.sendMessage('please fail')
  const failedCall = failed.toolCalls.find(c => c.errorTag !== undefined)
  check('a failing tool is recorded as a tagged error and the turn survives',
    failed.state === 'completed' && !!failedCall,
    failed.state + ' / ' + (failedCall ? failedCall.errorTag : 'no tagged call'))

  const trace = d.exportTrace()
  const kinds = new Set(trace.events.map(e => e.payload.kind))
  check('the trace records the turn end to end',
    kinds.has('TurnStarted') && kinds.has('ModelRequested') && kinds.has('ToolCallStarted') && kinds.has('TurnCompleted'),
    [...kinds].join(','))

  // pageErrors are judged by the caller, which knows this browser's allowances.
  return JSON.stringify({
    checks,
    pageErrors,
    webmcp,
    adapter: { id: adapter.id, specRevision: adapter.specRevision, candidates },
    errorTagFromHost: failedCall ? failedCall.errorTag : null,
    invalidErrorTagFromHost: invalidTag ?? null,
  })
})()`

interface Battery {
  checks: Array<{ name: string; pass: boolean; detail: string | null }>
  pageErrors: string[]
  webmcp?: { document: boolean; navigator: boolean }
  adapter: { id: string; specRevision: string; candidates: unknown } | null
  errorTagFromHost?: string | null
  invalidErrorTagFromHost?: string | null
}

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

const run = async () => {
  try {
    const probe = await fetch(BASE_URL)
    if (!probe.ok) throw new Error(String(probe.status))
  } catch {
    console.error(
      `Nothing is serving ${BASE_URL}.\n\n` +
        `  bun run build\n` +
        `  PORT=8791 GEO_DATA_MODE=fixture bun run server/index.ts &\n` +
        `  bun tools/browser-verify.ts\n`,
    )
    process.exit(2)
  }

  let failures = 0
  let skipped = 0
  const summary: string[] = []

  for (const target of TARGETS) {
    const availability = target.available()
    if (availability !== true) {
      console.log(`\n${YELLOW}SKIP${RESET} ${target.label} — ${availability}`)
      summary.push(`SKIP ${target.label}: ${availability}`)
      skipped++
      continue
    }

    let session: BrowserSession | undefined
    try {
      session = await target.open()
      await session.navigate(`${BASE_URL}/?driver=scripted&toolSets=todo,diagnostics`)
      const raw = await session.evaluate<string>(BATTERY)
      const result = JSON.parse(raw) as Battery

      const noise = target.knownConsoleNoise
      const isNoise = (line: string) => noise !== undefined && noise.pattern.test(line)
      const allErrors = [...session.consoleErrors(), ...result.pageErrors]
      const consoleErrors = allErrors.filter((line) => !isNoise(line))
      const excused = allErrors.filter(isNoise)

      const adapterOk = result.adapter?.id === target.expectAdapter
      const localFailures =
        result.checks.filter((c) => !c.pass).length + (adapterOk ? 0 : 1) + (consoleErrors.length > 0 ? 1 : 0)

      console.log(`\n${localFailures === 0 ? GREEN + 'PASS' : RED + 'FAIL'}${RESET} ${target.label}`)
      console.log(
        `  ${DIM}document.modelContext=${result.webmcp?.document} navigator.modelContext=${result.webmcp?.navigator}` +
          `  adapter=${result.adapter?.id} (${result.adapter?.specRevision})${RESET}`,
      )
      if (!adapterOk) {
        console.log(`  ${RED}✗${RESET} expected adapter ${target.expectAdapter}, got ${result.adapter?.id}`)
      }
      for (const c of result.checks) {
        console.log(`  ${c.pass ? GREEN + '✓' : RED + '✗'}${RESET} ${c.name}`)
        if (!c.pass && c.detail !== null) console.log(`      ${DIM}${c.detail}${RESET}`)
      }
      if (result.errorTagFromHost != null) {
        console.log(`  ${DIM}error tag surviving the host boundary: ${result.errorTagFromHost}${RESET}`)
      }
      if (result.invalidErrorTagFromHost != null) {
        console.log(`  ${DIM}structured input tag surviving the host boundary: ${result.invalidErrorTagFromHost}${RESET}`)
      }
      console.log(
        `  ${consoleErrors.length === 0 ? GREEN + '✓' : RED + '✗'}${RESET} no unexplained console or page errors` +
          (consoleErrors.length === 0 ? '' : `\n      ${DIM}${consoleErrors.join(' | ')}${RESET}`),
      )
      if (excused.length > 0 && noise !== undefined) {
        console.log(`  ${YELLOW}note${RESET} ${excused.length} known-noise line(s) — ${noise.why}`)
      }

      failures += localFailures
      summary.push(`${localFailures === 0 ? 'PASS' : 'FAIL'} ${target.label} (adapter ${result.adapter?.id})`)
    } catch (error) {
      if (error instanceof SafariAutomationDisabled) {
        console.log(`\n${YELLOW}SKIP${RESET} ${target.label} — ${error.message}`)
        console.log(
          `  ${DIM}Enable it once with:  sudo safaridriver --enable${RESET}\n` +
            `  ${DIM}(or Safari ▸ Settings ▸ Developer ▸ Allow Remote Automation)${RESET}`,
        )
        summary.push(`SKIP ${target.label}: remote automation disabled`)
        skipped++
      } else {
        console.log(`\n${RED}FAIL${RESET} ${target.label} — ${(error as Error).message}`)
        summary.push(`FAIL ${target.label}: ${(error as Error).message}`)
        failures++
      }
    } finally {
      await session?.close().catch(() => undefined)
    }
  }

  console.log(`\n${'─'.repeat(70)}`)
  for (const line of summary) console.log(line)
  console.log(
    `${'─'.repeat(70)}\n${failures === 0 ? GREEN + 'all checks passed' : RED + `${failures} check(s) failed`}${RESET}` +
      (skipped > 0 ? `${DIM}, ${skipped} target(s) skipped${RESET}` : ''),
  )
  process.exit(failures === 0 ? 0 : 1)
}

await run()
