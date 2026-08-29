# Tasks — WebMCP Test Chat Page

- **Status:** Executed — all phases complete, 2026-08-29
- **Last updated:** 2026-08-29
- **Inputs:** [`requirements.md`](./requirements.md) · [`design.md`](./design.md)

## Execution status

All ten phases are implemented and every checkpoint has been met. `bun run check` (types, lint,
216 tests + 1 deliberate skip) is green; `bun run build` and `bun run start` are verified.

Per-requirement evidence is in [`traceability.md`](./traceability.md), including the one remaining
gap: cross-browser verification (N6 / task 9.7) could not be performed, because no browser on this
machine implements WebMCP. Two gaps the audit itself found — an untested retry schedule and an
unasserted turn retry — were closed rather than recorded.

Three deviations from `design.md` were made during implementation and are documented in
[design §13](./design.md#13-implementation-notes) and [`docs/tech-debt.md`](../../tech-debt.md).

## How to read this

Tasks are dependency-ordered; anything in the same phase with no listed dependency can run in
parallel. Every task names the requirements it satisfies — if a task cannot be traced to a
requirement, it is out of scope and should be challenged rather than done.

`Deps` are task ids. `Size` is S (< 1 h), M (1–3 h), L (half a day).
Each phase ends with a **checkpoint**: a verifiable state, not a feeling of progress.

Baseline: the existing Vite 8 + React 19 + TypeScript 6 scaffold with the React Compiler enabled and
`bun.lock` present. Keep it; do not re-scaffold.

---

## Phase 0 — Foundation

Nothing here is interesting, and all of it is load-bearing. Get it wrong and every later task pays.

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 0.1 | Add dependencies: `hono@^4.13`, `effect@^3.22`, `tailwindcss@^4.3`, `@tailwindcss/vite@^4.3`; dev: `@hono/vite-dev-server@^0.26`, `vitest@^4.1`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`. Install with `bun`. | — | S | C |
| 0.2 | Wire Tailwind v4 through `@tailwindcss/vite`; delete `App.css`; define tokens in `@theme` in `index.css` including a `dark` variant. | 0.1 | S | §7.2 |
| 0.3 | Configure Vitest (jsdom for UI, node for server) and add `test`, `test:watch` scripts. | 0.1 | S | R9.2 |
| 0.4 | Add a `check` script running `tsc -b && eslint . && vitest run`. | 0.3 | S | R9.2 |
| 0.5 | Create the `src/{domain,ports,adapters,toolsets,app,ui}` and `server/` skeleton with an index barrel per directory. | — | S | §2.2 |
| 0.6 | Add the ESLint `no-restricted-syntax` rule banning `document.modelContext` / `navigator.modelContext` outside `src/adapters/webmcp/**`, plus a deliberately failing fixture to prove it fires. | 0.5 | M | **R6.1**, §10.3 |
| 0.7 | Replace the template `App.tsx`/`README.md` and remove template assets. | 0.5 | S | Boy-Scout |
| 0.8 | Add `.env.example` with every variable from design §8.1; confirm `.env` and `.traces/` are git-ignored. | — | S | R8.5, N5 |
| 0.9 | Add an ESLint rule flagging `throw` in `src/{domain,ports,app}` so control flow stays in the typed error channel; adapters and the host boundary are exempt and must say why in a comment. | 0.5 | M | **R7.1** |

**Checkpoint 0:** `bun run check` passes on an empty skeleton, and the fixtures for 0.6 and 0.9 prove
the adapter seam and the no-`throw` rule are machine-enforced rather than aspirational.

---

## Phase 1 — Domain and error model

Pure, dependency-free, and the vocabulary every later phase speaks.

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 1.1 | `domain/ids.ts`: branded `SessionId`, `TurnId`, `CallId`, `RequestId` with generators. | 0.5 | S | R5.1 |
| 1.2 | `domain/errors.ts`: every `Data.TaggedError` in design §5, each with its remedy hint. | 1.1 | M | **R7.2**, R5.13 |
| 1.3 | `domain/tool.ts`: `ToolDefinition`, `ToolAnnotations`, `ToolContext`, `ToolResult`, `ToolSet`. | 1.2 | M | R3.5, R3.7 |
| 1.4 | `domain/chat.ts`: `Message`, `Turn`, `TurnState` (`idle`/`running`/`completed`/`failed`/`cancelled`/`step_limit_exceeded`). | 1.1 | S | R1.1, R1.5 |
| 1.5 | `domain/trace.ts`: `TraceEnvelope` + the tagged `TraceEvent` union with constructors. | 1.1 | M | **R5.1** |
| 1.6 | Tool-name validator matching the spec's `^[A-Za-z0-9_.-]{1,128}$`, with tests for both bounds. | 1.3 | S | §3 |
| 1.7 | `JSONSchema.make` derivation helper + tests covering nested objects, enums, optional fields, and arrays. | 1.3 | M | **R3.5**, R2.7 |

**Checkpoint 1:** domain compiles with zero imports outside `effect`; schema derivation is tested.

---

## Phase 2 — Ports, runtime, trace

The spine. Everything after this plugs into it.

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 2.1 | `ports/ToolHost.ts` — the port exactly as design §4.1, with no host vocabulary. | 1.3 | M | **R6.1** |
| 2.2 | `ports/LlmClient.ts` — `CompletionRequest`/`CompletionResponse` including `raw`. | 1.4 | M | R4.3, R5.3 |
| 2.3 | `ports/TraceSink.ts` + `adapters/trace/memory-sink.ts`: 5 000-event ring buffer, discard marker, subscribers. | 1.5 | M | R5.1, **N2** |
| 2.4 | Custom Effect `Logger` fanning out to console and trace sink, level configurable at runtime. | 2.3 | M | **R7.5**, R5.7 |
| 2.5 | `app/runtime.ts`: `Layer` composition + `ManagedRuntime`, with a swappable test layer. | 2.1–2.4 | M | **R7.6** |
| 2.6 | `ui/hooks/useRun.ts`: the single Effect→React boundary; components never see an `Effect`. | 2.5 | M | §7.1 |
| 2.7 | `app/config.ts`: client config from URL query with defaults, and a writer keeping the URL in sync. | 1.1 | M | **R2.8**, R6.4 |
| 2.8 | Span conventions: name and wrap turn, model call, and tool call with `Effect.withSpan`; feed span timings into trace events so the inspector needs no separate timing instrumentation. | 2.3 | M | **R7.4** |

**Checkpoint 2:** a throwaway component logs through Effect and the event appears in the memory sink
with correct `seq`, `sessionId`, and duration.

---

## Phase 3 — WebMCP adapters

The spec-churn seam. Build the in-memory adapter and the conformance suite **first** — the suite is
the specification of what an adapter is, and writing it after the adapters inverts the leverage.

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 3.1 | `adapters/webmcp/in-memory.ts`: `Map`-backed host, own `toolchange` emitter. | 2.1 | M | **R6.2** |
| 3.2 | `conformance.test.ts`: shared, adapter-parameterised suite — register/list/execute/unregister, duplicate names, unknown tool, invalid input, abort mid-execution, `toolchange` emission, scope cleanup. Skips with a printed reason when a host is absent. | 3.1 | **L** | **R6.5** |
| 3.3 | Shared `runToolFromHost` helper: decode → span → fault injection → timeout → trace events → promise. | 1.7, 2.3 | L | R3.6, R5.10, §4.3 |
| 3.4 | `adapters/webmcp/draft-2026-04.ts` against `document.modelContext`; passes 3.2. | 3.2, 3.3 | L | **R6.2** |
| 3.5 | `adapters/webmcp/legacy-navigator.ts` against `navigator.modelContext.provideContext`, emulating per-tool unregister via whole-set replacement; passes 3.2. | 3.2, 3.3 | L | **R6.2**, ADR-5 |
| 3.6 | `detect.ts`: capability probes, precedence, and a `DetectionReport` recording **why each candidate was rejected**. | 3.4, 3.5 | M | **R6.3** |
| 3.7 | `registry.ts`: the adapter catalogue with `specRevision` + spec URL per entry — the single line a new adapter adds. | 3.6 | S | **R6.6**, R6.7 |
| 3.8 | Scoped registration lifecycle: reverse-order unregister on disable, adapter switch, reset, failure, and interruption. | 3.4, 3.5 | M | **R7.7**, R2.3 |
| 3.9 | Preserve the host's own error verbatim alongside the normalised tag in every adapter failure path. | 3.4, 3.5 | S | **R6.8** |
| 3.10 | Fault injector service (`fail` / `hang` / `invalid`, armed for the next *n* calls). | 3.3 | M | **R5.10** |

**Checkpoint 3:** the conformance suite passes against all three adapters (real ones skipped with a
printed reason where unsupported). **This is the phase that proves R6; do not proceed past a partial
pass.**

---

## Phase 4 — Tool sets

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 4.1 | `toolsets/todo.ts` — create/list/complete/delete over in-page state. | 3.3 | M | R3.1 |
| 4.2 | `toolsets/page-control.ts` — theme, scroll, navigate-to-section, highlight; visibly mutates the page. | 3.3, 0.2 | M | R3.2 |
| 4.3 | `toolsets/forms.ts` — enums, optionals, nested objects; stresses schema derivation. | 3.3, 1.7 | M | R3.3 |
| 4.4 | `toolsets/diagnostics.ts` — `echo`, `fail`, `hang`, `huge-output`, `invalid-output`. | 3.3, 3.10 | M | **R3.4** |
| 4.5 | `toolsets/index.ts` registry; adding a set touches only its module and this file. | 4.1–4.4 | S | **R3.8** |
| 4.6 | Duplicate-name detection across enabled sets, naming both owners. | 4.5 | M | **R2.6** |
| 4.7 | Annotate every tool with `readOnlyHint` / `untrustedContentHint` and assert propagation to the host. | 4.1–4.4 | S | R3.7 |

**Checkpoint 4:** every tool set registers and executes against the in-memory adapter; the
diagnostics set reproduces each failure mode on demand.

---

## Phase 5 — Backend

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 5.1 | `server/config.ts`: env parsed via Effect `Schema`, failing fast with the offending variable name. | 1.2 | M | **R8.5** |
| 5.2 | Hono app bound to `127.0.0.1`, CORS limited to the dev origin. | 5.1 | S | **R8.6** |
| 5.3 | Request logger: one structured line with method, path, status, duration, `x-request-id`. | 5.2 | S | R8.4, R5.8 |
| 5.4 | `GET /api/health` — always 200, body reports upstream reachability and model count. | 5.2 | M | **R8.2**, ADR-6 |
| 5.5 | `GET /api/llm/models` — empty list rather than 500 when upstream is down. | 5.4 | S | R4.7 |
| 5.6 | `POST /api/llm/chat` — body validated at the boundary, 400 with structured field errors. | 5.2 | L | R8.1, **R8.3** |
| 5.7 | Upstream call: timeout, ≤2 retries with exponential backoff, never retrying a started response; distinct errors for unreachable / non-2xx / unparseable. | 5.6 | L | **R4.8**, **R4.9** |
| 5.8 | `POST /api/traces` — `sessionId` pattern-checked, resolved path confirmed inside `.traces/`. | 5.2 | M | **R8.7**, R5.6 |
| 5.9 | `@hono/vite-dev-server` integration: one `bun run dev`, one log stream, HMR both sides. | 5.2 | M | **R9.1** |
| 5.10 | Production build: SPA emitted and served statically by the backend. | 5.9 | M | C |

**Checkpoint 5:** `bun run dev` serves UI and API from one process; `/api/health` correctly reports
"upstream unreachable" with **no** LLM installed — the state this machine is actually in today.

---

## Phase 6 — LLM drivers and agent loop

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 6.1 | `adapters/llm/scripted.ts` — deterministic driver + scenario file (multi-step, tool failure, parse failure, step-limit). | 2.2 | L | **R4.3** |
| 6.2 | `adapters/llm/local.ts` — calls the backend, normalises, carries `raw` and `requestId` through. | 2.2, 5.6 | L | R4.1, R4.2, R5.3 |
| 6.3 | `tool-call.ts` `native` strategy: `tools` param out, `tool_calls` in. | 6.2 | M | R4.5 |
| 6.4 | `tool-call.ts` `prompted` strategy: system-prompt builder + tolerant parser (fenced → balanced braces → give up), emitting `ToolCallParseFailed` and falling back to plain text. | 6.3 | **L** | **R4.5**, **R4.6** |
| 6.5 | Driver selection with automatic fallback to `scripted` when no endpoint is reachable, stated explicitly in the UI rather than failing the first request. | 6.1, 6.2, 5.4 | M | **R4.4** |
| 6.6 | `app/agent-loop.ts` — turn lifecycle, per-turn scope + `AbortController`, tools re-listed from the host each step. | 3.8, 6.5 | **L** | R1.1, R1.4, **R2.4** |
| 6.7 | Feed tool failures back as tool results (`isError: true`); abort the turn only on host-level failure. | 6.6 | M | ADR-7 |
| 6.8 | Step limit (default 8): halt, mark `step_limit_exceeded`, render the partial transcript. | 6.6 | S | **R1.5** |
| 6.9 | Cancellation: one control aborts model request and running tool alike. | 6.6 | M | **R1.3** |
| 6.10 | Loop tests over scripted driver + in-memory host: multi-step, recovery, step limit, cancel — fully deterministic, `TestClock` for timing. | 6.6–6.9 | L | R9.2, §10 |

**Checkpoint 6:** a full multi-step turn runs headlessly with no browser WebMCP and no LLM, and the
trace shows every step in order.

---

## Phase 7 — UI

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 7.1 | Three-pane shell + status bar (adapter, spec revision, driver, model, backend health, tool count, turn state). | 2.6, 0.2 | L | **R5.12**, R6.7 |
| 7.2 | Chat transcript with inline, expandable tool-call entries showing name, args, result, duration. | 7.1, 6.6 | L | **R1.6** |
| 7.3 | Composer: submit, disabled-while-running, cancel control. | 7.2 | M | R1.1, R1.2, R1.3 |
| 7.4 | Retry control replaying an errored turn from its originating user message. | 7.2 | M | R1.7 |
| 7.5 | Selector pane: tool sets with per-tool registration outcome, adapter/driver/model pickers, fault-injection control. | 4.5, 3.7, 6.5 | L | R2.1, R2.2, R2.3, R5.10 |
| 7.6 | Registered-tool list read from the host, refreshed on `toolchange` within one frame. | 3.1, 7.5 | M | **R2.4**, **R2.5** |
| 7.7 | Per-tool JSON Schema viewer. | 7.5, 1.7 | S | R2.7 |
| 7.8 | Inspector: virtualised list, filter by kind and turn, expandable raw JSON. | 2.3, 7.1 | **L** | **R5.2**, R5.3, N2 |
| 7.9 | Copy affordances: single event, whole turn, whole trace. | 7.8 | M | R5.4 |
| 7.10 | Error rendering: tag, message, remedy hint, correlation ids — never a bare object or stack. Defects get a visually distinct loud state. | 1.2, 7.8 | M | **R5.13**, **R7.3** |
| 7.11 | `data-testid` on every interactive element, `<area>-<element>-<qualifier>`. | 7.1–7.10 | M | **R5.11** |
| 7.12 | Session reset control clearing transcript, trace, and registrations. | 7.1 | S | R1.8 |
| 7.13 | Accessibility pass: keyboard operability, transcript as a live region, visible focus. | 7.1–7.12 | M | **N3** |
| 7.14 | Component tests: selector toggling, transcript rendering, inspector filtering. | 7.5, 7.8 | L | R9.2 |

**Checkpoint 7:** a full conversation is driveable by mouse and keyboard, and every step is visible in
the inspector without leaving the page.

---

## Phase 8 — Debug surface and persistence

The phase that makes the top-priority requirement real rather than aspirational.

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 8.1 | `app/debug-handle.ts` — install `window.__WEBMCP_DEBUG__` with the full interface from design §9. | 6.6, 7.5 | **L** | **R5.9** |
| 8.2 | `callTool(name, input)` executing against the host with the model bypassed entirely. | 8.1, 3.3 | M | **R5.9**, §9 |
| 8.3 | `waitForIdle(timeoutMs)` resolving on turn settle, for agent-driven scripting. | 8.1, 6.6 | M | R5.9 |
| 8.4 | Trace export to a self-contained JSON file. | 2.3 | M | R5.5 |
| 8.5 | Trace import reconstructing transcript and inspector read-only. | 8.4, 7.2 | L | **R5.5** |
| 8.6 | `saveTrace()` → `POST /api/traces` → `.traces/<sessionId>.json`, returning the path. | 8.4, 5.8 | M | **R5.6** |
| 8.7 | Verify `x-request-id` joins client trace to server log for one request, end to end. | 5.3, 6.2 | M | **R5.8** |
| 8.8 | Console log level switchable at runtime via the debug handle. | 2.4, 8.1 | S | R5.7 |
| 8.9 | Measure framework overhead per trivial tool call; assert < 5 ms. | 3.3, 8.2 | M | **N1** |

**Checkpoint 8:** a coding agent, using only `window.__WEBMCP_DEBUG__` and `.traces/<id>.json`,
reproduces a seeded diagnostics failure and identifies the exact event that explains it — with no
screenshot and no DOM scraping. **This is the acceptance test for the project's stated top priority.**

---

## Phase 9 — Documentation and close-out

| # | Task | Deps | Size | Reqs |
| --- | --- | --- | --- | --- |
| 9.1 | README: purpose, `bun run dev`, and installing a local LLM (Ollama, LM Studio, llama.cpp) — noting the app runs without one. | 6.5 | M | **R9.3** |
| 9.2 | README "Debugging with a coding agent": the run → drive → `saveTrace()` → read-file loop, with a worked example. | 8.6 | M | **R9.4** |
| 9.3 | `docs/adding-an-adapter.md`: the exact steps and the conformance bar a new WebMCP revision must clear. | 3.7 | M | **R6.6** |
| 9.4 | `docs/adding-a-toolset.md`. | 4.5 | S | R3.8 |
| 9.5 | Traceability audit: every `R*` criterion maps to a passing test or a documented manual check; record gaps explicitly. | all | M | §7 DoD |
| 9.6 | Offline check: no third-party origins requested at runtime. | 9.1 | S | **N4** |
| 9.7 | Cross-browser check on Chrome, Edge, Firefox, Safari; confirm graceful degradation to the in-memory adapter. | 7.13 | M | **N6** |
| 9.8 | Record any technical debt taken, with rationale, in `docs/tech-debt.md`. | all | S | Boy-Scout |

**Checkpoint 9 — Definition of done:** `bun run check` green; conformance suite green for all three
adapters; every requirement traced; the README reproduction loop works verbatim on a clean checkout.

---

## Sequencing notes

**Critical path:** 0.6 → 2.1 → 3.2 → 3.4 → 6.6 → 8.1. Tasks 3.2 and 8.1 are where this project either
delivers its two stated priorities or quietly fails to; neither should be compressed under time
pressure.

**Parallelisable:** Phase 4 tool sets are independent of each other and of Phase 5. Phase 5 (backend)
runs alongside Phase 3 (adapters) — they share only DTOs. Phase 7 UI tasks fan out once 7.1 lands.

**Deliberate ordering choice:** the conformance suite (3.2) precedes every real adapter, and the
in-memory adapter (3.1) precedes both. Writing the suite first forces the port to be defined by what
*any* host must do rather than by what today's draft happens to expose — which is the entire
mechanism by which R6 is satisfied.

**Deferred, per requirements §8:** streaming (ADR-4), remote MCP servers, trace persistence across
reloads, conversation branching, Playwright suite. None are blocked by these tasks; the
`CompletionResponse` shape in particular leaves room for streaming.
