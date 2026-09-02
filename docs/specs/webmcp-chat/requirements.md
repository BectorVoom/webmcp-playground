# Requirements — WebMCP Test Chat Page

- **Status:** Draft
- **Last updated:** 2026-08-29
- **Spec baseline:** W3C WebMCP Community Group Draft Report, 2026-04-23 (`document.modelContext`)

## 1. Introduction

The WebMCP Test Chat Page is a local playground for exercising the
[WebMCP](https://webmachinelearning.github.io/webmcp/) browser API. The page acts as a **tool
provider**: it registers tool sets with the browser's model-context registry. It also embeds its own
**agent**, a chat interface backed by a local LLM, which discovers and invokes those tools. This
closes the loop inside one page, so WebMCP behaviour can be tested without an agentic browser and in
browsers that do not implement the API at all.

The product's primary user is not an end user — it is a **coding agent** working on WebMCP
integrations. Every requirement below is written with that reader in mind: the system must make its
own behaviour legible, reproducible, and machine-readable.

### 1.1 Goals

1. Exercise the full WebMCP round trip — register → discover → execute → return — from a real page.
2. Make every step of that round trip observable, correlatable, and exportable.
3. Absorb WebMCP specification changes at a single, well-known seam.
4. Run entirely offline against a local LLM.

### 1.2 Non-goals

- Acting as a general-purpose chat product, or persisting conversations beyond a browser session.
- Connecting to remote MCP servers over stdio/HTTP (see [Deferred](#8-deferred-scope)).
- Multi-user, authentication, or deployment beyond `localhost`.
- Shipping a WebMCP polyfill for other sites to consume.

### 1.3 Glossary

| Term | Meaning |
| --- | --- |
| **WebMCP** | The browser API letting a page expose tools to an agent. Current draft: `document.modelContext`. |
| **Tool host** | The registry a tool is registered into. Either the browser's, or our in-memory stand-in. |
| **Adapter** | An implementation of `ToolHostPort` targeting one concrete WebMCP API shape. |
| **Tool set** | A named, selectable bundle of related tools (e.g. `todo`, `diagnostics`). |
| **Driver** | An implementation of `LlmClientPort`. Either a local LLM or a deterministic script. |
| **Turn** | One user message and everything that follows until the agent produces a final reply. |
| **Trace** | The ordered, correlated event log for a session. |

### 1.4 Requirement conventions

Acceptance criteria use EARS phrasing (`WHEN…SHALL`, `IF…THEN…SHALL`, `WHILE…SHALL`,
`WHERE…SHALL`). Each is individually verifiable. IDs are stable: `R<n>.<m>`, referenced by
`design.md` and `tasks.md`.

---

## 2. Functional requirements

### R1 — Chat interface

**As a** developer testing WebMCP, **I want** a chat surface that drives an agent loop, **so that**
tool invocation happens the way it would with a real browser agent.

| ID | Criterion |
| --- | --- |
| R1.1 | WHEN the user submits a non-empty message, THE SYSTEM SHALL append it to the transcript and begin a new turn with a unique `turnId`. |
| R1.2 | WHILE a turn is in flight, THE SYSTEM SHALL disable message submission and display a cancel control. |
| R1.3 | WHEN the user activates the cancel control, THE SYSTEM SHALL abort the in-flight model request and any running tool execution via their `AbortSignal`, and mark the turn `cancelled`. |
| R1.4 | WHEN the model returns tool calls, THE SYSTEM SHALL execute each through the active tool host, append the results to the message history, and re-invoke the model. |
| R1.5 | WHEN a turn reaches the configured maximum step count (default 8), THE SYSTEM SHALL halt the loop, mark the turn `step_limit_exceeded`, and render the partial transcript. |
| R1.6 | THE SYSTEM SHALL render tool calls inline in the transcript as distinct, expandable entries showing tool name, arguments, result, and duration. |
| R1.7 | IF the transcript contains an errored turn, THEN THE SYSTEM SHALL offer a retry control that replays that turn from its originating user message. |
| R1.8 | THE SYSTEM SHALL persist the transcript and trace for the lifetime of the page session only, and SHALL provide an explicit reset control. |

### R2 — WebMCP selector

**As a** developer, **I want** to choose which tool sets are live, **so that** I can isolate the
behaviour under test.

| ID | Criterion |
| --- | --- |
| R2.1 | THE SYSTEM SHALL present all available tool sets with id, title, description, and tool count. |
| R2.2 | WHEN the user toggles a tool set on, THE SYSTEM SHALL register each of its tools with the active adapter and reflect the outcome per tool (`registered` / `failed` with reason). |
| R2.3 | WHEN the user toggles a tool set off, THE SYSTEM SHALL unregister its tools by aborting their registration signal. |
| R2.4 | THE SYSTEM SHALL expose the currently registered tools as read back **from the host** — not from local state — so that a divergence between intent and host reality is visible. |
| R2.5 | WHEN the tool host emits a `toolchange` event, THE SYSTEM SHALL refresh the displayed tool list within one animation frame. |
| R2.6 | IF two enabled tool sets declare the same tool name, THEN THE SYSTEM SHALL refuse the second registration and surface a `DuplicateToolName` conflict naming both sets. |
| R2.7 | THE SYSTEM SHALL let the user inspect any registered tool's generated JSON Schema verbatim. |
| R2.8 | THE SYSTEM SHALL restore the selected tool sets, adapter override, and driver choice from the URL query string on load, and SHALL keep the URL in sync as they change. |

### R3 — Tool sets

| ID | Criterion |
| --- | --- |
| R3.1 | THE SYSTEM SHALL ship a `todo` tool set exercising stateful create/list/complete/delete operations against in-page state. |
| R3.2 | THE SYSTEM SHALL ship a `page-control` tool set exercising side effects on the page itself (theme, scroll, navigate to a section, highlight an element). |
| R3.3 | THE SYSTEM SHALL ship a `forms` tool set exercising structured multi-field input, including enums, optional fields, and nested objects. |
| R3.4 | THE SYSTEM SHALL ship a `diagnostics` tool set whose tools deliberately fail, hang, exceed size limits, return schema-violating output, and echo their input. |
| R3.5 | THE SYSTEM SHALL declare each tool's input schema exactly once, and derive both runtime validation and the published JSON Schema from that single declaration. |
| R3.6 | WHEN a tool is invoked with input that does not satisfy its schema, THE SYSTEM SHALL reject the call with a structured validation error naming the offending paths, and SHALL NOT run the tool body. |
| R3.7 | THE SYSTEM SHALL annotate each tool with `readOnlyHint` and `untrustedContentHint` and SHALL propagate those annotations to the host. |
| R3.8 | Adding a new tool set SHALL require no change outside its own module and one registry entry. |

### R4 — Local LLM integration

| ID | Criterion |
| --- | --- |
| R4.1 | THE SYSTEM SHALL call the local model through an OpenAI-compatible `/v1/chat/completions` endpoint whose base URL is configurable, defaulting to `http://localhost:11434/v1` (Ollama). |
| R4.2 | THE SYSTEM SHALL route all model traffic through the Hono backend, and the browser SHALL NOT hold any upstream credential. |
| R4.3 | THE SYSTEM SHALL offer at least two drivers — `local` (the configured endpoint) and `scripted` (a deterministic in-browser stub) — selectable at runtime without a rebuild. |
| R4.4 | THE SYSTEM SHALL default to the `scripted` driver when no local endpoint is reachable, and SHALL say so explicitly rather than failing the first chat request. |
| R4.5 | THE SYSTEM SHALL support both `native` tool calling (the `tools` request parameter) and a `prompted` fallback that instructs the model to emit tool calls as JSON and parses them, because many local models lack native tool-call support. |
| R4.6 | WHEN the tool-call strategy is `prompted` and the model's output cannot be parsed as a tool call, THE SYSTEM SHALL treat the output as a final text reply and SHALL record the parse failure in the trace. |
| R4.7 | THE SYSTEM SHALL list the models available at the configured endpoint and let the user pick one. |
| R4.8 | THE SYSTEM SHALL apply a configurable request timeout (default 120 s) and SHALL retry transport-level failures with exponential backoff, at most 2 retries, never retrying a request the model already began answering. |
| R4.9 | IF the endpoint is unreachable, returns a non-2xx status, or returns unparseable JSON, THEN THE SYSTEM SHALL surface a distinct, named error for each of those three cases together with the remedy (e.g. "start Ollama with `ollama serve`"). |

### R5 — Observability and debuggability *(top priority)*

| ID | Criterion |
| --- | --- |
| R5.1 | THE SYSTEM SHALL record every model request, model response, tool discovery, tool call, tool result, adapter event, and error as a typed trace event carrying `sessionId`, `turnId`, monotonic sequence number, timestamp, and duration where applicable. |
| R5.2 | THE SYSTEM SHALL present the trace in an always-available inspector panel, filterable by event kind and by turn. |
| R5.3 | THE SYSTEM SHALL show the verbatim JSON of every model request and response, including the exact `tools` array sent. |
| R5.4 | THE SYSTEM SHALL let the user copy any single event, any turn, or the whole trace to the clipboard as JSON. |
| R5.5 | THE SYSTEM SHALL export a trace as a single self-contained JSON file, and SHALL import such a file to reconstruct the transcript and inspector view read-only. |
| R5.6 | WHERE the backend is running, THE SYSTEM SHALL be able to write the trace to `.traces/<sessionId>.json` on disk, so a coding agent can read it without a browser. |
| R5.7 | THE SYSTEM SHALL emit correlated structured logs to the browser console at a runtime-configurable level, using the same identifiers as the inspector. |
| R5.8 | THE SYSTEM SHALL propagate a `x-request-id` between browser and backend and SHALL display it on every backend-originated event, so client and server logs can be joined. |
| R5.9 | THE SYSTEM SHALL expose `window.__WEBMCP_DEBUG__` with, at minimum: `getTrace()`, `getTools()`, `getAdapter()`, `callTool(name, input)`, `setToolSets(ids)`, `setDriver(id)`, `sendMessage(text)`, `waitForIdle()`, and `reset()`, so an agent can drive and inspect the page without simulating UI events. |
| R5.10 | THE SYSTEM SHALL provide fault injection: the user or `window.__WEBMCP_DEBUG__` can arm the next *n* tool calls to fail, hang, or return invalid output. |
| R5.11 | THE SYSTEM SHALL attach a stable `data-testid` to every interactive element, following the convention `<area>-<element>-<qualifier>`. |
| R5.12 | THE SYSTEM SHALL display a persistent status bar reporting the active adapter, active driver and model, backend health, registered tool count, and current turn state. |
| R5.13 | WHEN an error reaches the UI, THE SYSTEM SHALL render its error tag, human-readable message, remedy hint, and correlation ids — never a bare `[object Object]` or an unlabelled stack. |

### R6 — Adaptability to WebMCP specification change

**As a** maintainer, **I want** spec churn confined to one directory, **so that** a breaking browser
change is a contained edit rather than a refactor.

| ID | Criterion |
| --- | --- |
| R6.1 | THE SYSTEM SHALL define a single internal port, `ToolHostPort`, expressed in the application's own vocabulary, and no module outside `src/adapters/webmcp/` SHALL reference `document.modelContext`, `navigator.modelContext`, or any other host-specific global. |
| R6.2 | THE SYSTEM SHALL ship at least three adapters: the current draft (`document.modelContext.registerTool`), the superseded shape (`navigator.modelContext.provideContext`), and an in-memory host requiring no browser support. |
| R6.3 | WHEN the page loads, THE SYSTEM SHALL detect host capabilities and select the highest-precedence supported adapter, and SHALL record the detection result — including why each candidate was rejected — in the trace. |
| R6.4 | THE SYSTEM SHALL let the user override adapter selection at runtime, including forcing the in-memory adapter. |
| R6.5 | THE SYSTEM SHALL run one shared conformance test suite against every adapter, so a new adapter is proven equivalent before use. |
| R6.6 | Supporting a new WebMCP API shape SHALL require adding one adapter module and one registry entry, with no change to domain, UI, or agent-loop code. |
| R6.7 | THE SYSTEM SHALL record, per adapter, the spec revision it targets and a link to that revision, and SHALL display the active adapter's revision in the UI. |
| R6.8 | IF an adapter operation fails because the host rejected it, THEN THE SYSTEM SHALL surface the host's own error verbatim alongside the normalised error tag, so spec drift is diagnosable rather than swallowed. |

### R7 — Error handling and logging (Effect)

| ID | Criterion |
| --- | --- |
| R7.1 | THE SYSTEM SHALL model every fallible operation as an `Effect` with an explicitly typed error channel; no application module SHALL rely on `throw` for control flow. |
| R7.2 | THE SYSTEM SHALL define errors as discriminated tagged types (`Data.TaggedError`), and every handler SHALL be exhaustive over the tags it can receive. |
| R7.3 | THE SYSTEM SHALL distinguish expected failures (typed error channel) from defects (unexpected throws), and SHALL surface defects as a distinct, loud UI state. |
| R7.4 | THE SYSTEM SHALL wrap each meaningful operation in a named span, and span timings SHALL appear in the inspector. |
| R7.5 | THE SYSTEM SHALL install a custom `Logger` that fans out to the browser console and the trace store, so one log call reaches both. |
| R7.6 | THE SYSTEM SHALL supply dependencies as `Layer`s, and tests SHALL substitute a test layer without touching production wiring. |
| R7.7 | THE SYSTEM SHALL ensure that resources acquired for a turn (abort controllers, subscriptions, timers) are released on success, failure, and interruption alike. |

### R8 — Backend (Hono)

| ID | Criterion |
| --- | --- |
| R8.1 | THE SYSTEM SHALL expose `POST /api/llm/chat`, `GET /api/llm/models`, `GET /api/health`, and `POST /api/traces`. |
| R8.2 | `GET /api/health` SHALL report backend liveness, the configured upstream base URL, upstream reachability, and the resolved model list length, without failing the request when the upstream is down. |
| R8.3 | THE SYSTEM SHALL validate every request body at the backend boundary and SHALL return a `400` with a structured body naming the invalid fields. |
| R8.4 | THE SYSTEM SHALL log one structured line per request containing method, path, status, duration, and `x-request-id`. |
| R8.5 | THE SYSTEM SHALL read all configuration from environment variables with documented defaults, and SHALL fail fast at startup with a precise message if a required variable is malformed. |
| R8.6 | THE SYSTEM SHALL bind to `127.0.0.1` by default, SHALL require an explicit `HOST` override for a production bind, and SHALL NOT enable permissive CORS for non-local origins. |
| R8.7 | WHERE `POST /api/traces` is enabled, THE SYSTEM SHALL write only inside the project's `.traces/` directory and SHALL reject any `sessionId` that is not a plain identifier. |

### R9 — Developer experience

| ID | Criterion |
| --- | --- |
| R9.1 | A single command SHALL start frontend and backend together, sharing one terminal log stream. |
| R9.2 | THE SYSTEM SHALL type-check, lint, and test via discrete scripts, and all three SHALL pass on a clean checkout. |
| R9.3 | THE SYSTEM SHALL work with no local LLM installed, defaulting to the scripted driver, and the README SHALL state how to install one. |
| R9.4 | THE SYSTEM SHALL document, in the README, how a coding agent reproduces a bug end to end: run, drive via `window.__WEBMCP_DEBUG__`, read `.traces/<id>.json`. |

## 3. Non-functional requirements

| ID | Criterion |
| --- | --- |
| N1 | Tool execution overhead added by the framework (validation, tracing, span bookkeeping) SHALL stay under 5 ms per call for a trivial tool. |
| N2 | The inspector SHALL remain responsive with 5 000 trace events, retaining at least the most recent 5 000 and discarding older ones with a visible marker. |
| N3 | The UI SHALL be operable by keyboard, and the transcript SHALL be announced to assistive technology as a live region. |
| N4 | The app SHALL run offline once dependencies are installed; no requests to third-party origins at runtime. |
| N5 | Secrets SHALL come from the environment only, and `.env` SHALL be git-ignored. |
| N6 | The app SHALL target current Chrome, Edge, Firefox, and Safari; WebMCP-specific behaviour degrades to the in-memory adapter where the API is absent. |

## 4. Constraints

- macOS development host; Bun as package manager and script runner; Vite as build tool.
- React + TypeScript SPA; Hono backend; Effect for errors, logging, and dependency wiring; Tailwind CSS for styling.
- The existing scaffold (Vite 8, React 19, TypeScript 6, React Compiler enabled) is retained.
- WebMCP requires a secure context; `http://localhost` qualifies.

## 5. Assumptions

1. The local LLM speaks the OpenAI-compatible `/v1` surface. Ollama, LM Studio, llama.cpp's server, and vLLM all do.
2. No LLM runtime is installed on the host yet, so the scripted driver must carry development until one is.
3. Local models are unreliable at native tool calling; the `prompted` strategy is required, not optional.
4. The WebMCP draft will change again during this project's life — assumed, not feared.

## 6. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| WebMCP shape changes again | Adapters break | R6 adapter seam plus shared conformance suite (R6.5) |
| Local model cannot call tools | Core loop untestable | `prompted` strategy (R4.5) and scripted driver (R4.3) |
| Trace volume degrades UI | Inspector unusable | Bounded ring buffer (N2), virtualised list |
| Effect learning curve | Slower delivery | Confine Effect to services and the agent loop; React sees plain values through one runner hook |
| Browser lacks WebMCP entirely | Nothing to test | In-memory adapter is a first-class host, not a fallback (R6.2) |

## 7. Acceptance — definition of done

The feature is complete when: every `R*` criterion has a passing automated test or a documented
manual check; the adapter conformance suite passes for all three adapters; `bun run check`
(types + lint + test) is green; and a coding agent can, following only the README, reproduce a
seeded tool failure and point to the exact trace event that explains it.

## 8. Deferred scope

Streaming responses (SSE) — deferred to keep the first loop synchronous and trivially inspectable;
remote MCP server connectivity; trace persistence across reloads; multi-turn conversation branching;
Playwright end-to-end suite.
