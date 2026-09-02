# Technical debt

Recorded deliberately, with the reasoning, so a later reader can tell a considered trade-off from an
oversight.

## Fixed

**1. The inspector virtualises its event list.** *(fixed)*
Every matching trace event is now reachable by scrolling — there is no 300-event window or repeated
"show older" action. `@tanstack/react-virtual` measures the expandable rows and mounts only the
viewport plus a small overscan, keeping the inspector responsive with the 5,000-event N2 retention
cap. The component test drives the list to the end of a 500-event trace and asserts that it did not
mount all 500 rows.

**2. `ToolHostPort` exposes tool-set changes as a `Stream`.** *(fixed)*
Each adapter now exposes `changes: Stream.Stream<void>`. The stream acquires a host listener only
while a consumer fiber is live and releases it on interruption; the selector owns one fiber per
mounted host and the session owns one for trace events, replacing it when the host changes. The
conformance suite proves both delivery and listener cleanup for every adapter.

**3. Structured errors degraded across a lossy host.** *(fixed)*
Chrome and Edge do turn any rejected tool callback into one opaque `DOMException`, but they preserve
a fulfilled tool result. The draft adapter now returns a versioned, JSON-safe `isError` result for a
`ToolBoundaryError`, then decodes it after `executeTool()` returns. `ToolInputInvalid`,
`ToolTimeout`, `ToolAborted`, and `ToolExecutionError` therefore retain their tags even through the
browser-shaped DOMException host; only an unrelated host rejection remains a generic
`ToolExecutionError` with its verbatim host message. The conformance suite asserts the precise tags
against both the lossy and browser-shaped hosts.

**4. Cross-browser verification was incomplete.** *(fixed — and it found four live defects)*
`bun tools/browser-verify.ts` drives the built app through `window.__WEBMCP_DEBUG__` over each
browser's own automation protocol — CDP for Chrome and Edge, WebDriver BiDi for Firefox, macOS's own
`safaridriver` for Safari — with no driver library added, so the deferred-scope decision on a
Playwright suite stays intact. Twelve checks per target; Chrome 152, Edge 151, Firefox 154 and
Safari 26.6 all pass, stock and (for the Chromium pair) flagged.

The premise recorded here had expired. `document.modelContext` **is** implemented — Chrome 152 and
Edge 151 both expose a real `ModelContext` behind `--enable-experimental-web-platform-features` — so
the spec adapters had been running only against our own model of the host, and that model was wrong
in four ways: arguments must cross as a JSON string, the `execute` callback gets no `options` (and so
no `AbortSignal`), `inputSchema` comes back stringified, and rejections are `DOMException`s that
`JSON.stringify` renders `"{}"`. Every one was a live failure against a shipping browser. All four
are fixed, and the fakes now reproduce the real contract so the conformance suite catches a
regression — including a `browser-shaped` case with `supportsCancellation: false`.

Safari needs `sudo safaridriver --enable` once per machine before its automation will start; until it
is, the harness reports a loud SKIP rather than passing over it. Full record and measurements:
[browser verification](browser-verification.md).

**5. `LlmTimeout` lost its duration across the backend boundary.** *(fixed)*
The backend now sends the failing error's own fields, not just its tag: `ChatProxyErrorBody` in
`src/domain/wire.ts` is the shared shape, built once in `server/routes/llm.ts` and reconstructed in
`src/adapters/llm/local.ts`. `LlmTimeout` carries `timeoutMs`, `LlmProtocolError` carries
`bodyExcerpt`, and `ModelLacksToolSupport` carries the host's verbatim `hostMessage` rather than our
own sentence wrapped back around itself. Covered end-to-end — real app, real adapter — in
`server/llm-error-body.test.ts`. A new tagged field belongs in that shape, or the remedy the user
reads has a hole in it.

**6. Turn and call ids were module-global counters.** *(fixed)*
`createIdFactory()` in `src/domain/ids.ts` holds the counters per session; `createSession` makes one
and hands it to the loop and the tool runner, so "monotonic within a session" is enforced rather
than assumed. `resetIdCounters()` is gone, and with it the `beforeEach` calls that existed only to
undo module state. Two sessions in one document now each number from `turn_1`
(`src/app/session.test.ts`).

**7. Prompted mode was unusable with a thinking model.** *(fixed — and the recorded diagnosis was
wrong)*
The note said the model "can exhaust its output budget" reasoning. Measured against `gemma4:e4b`
through the real prompted path, that is not what happens: across 36 asks, 7 came back with empty
content and **all 36 had `finish_reason: "stop"`** — never `"length"`. The model reasons its way to a
decision and then ends its turn without stating it. Truncation only appears if `max_tokens` is
forced down to ~40, which nothing here does.

So the fix is not a bigger budget. When a step returns neither text nor a tool call, the loop asks
once more with a short nudge (`emptyResponseNudge` in `src/app/agent-loop.ts`) repeating the
instruction the model reasoned past. In measurement that recovered 7 of 7; end to end through the
real loop and backend, 8 of 8 turns completed with one step rescued by the re-ask.

Re-asking is safe *here specifically* and nowhere else in this codebase: an empty reply named no
tool, so nothing ran and there is no side effect to double — the opposite of the deliberate
no-retry in `server/upstream.ts`. Guard rails: exactly one extra ask per step, never a loop; the
nudge prods that one request and never enters the transcript; the retry is recorded as an
`EmptyResponseRetried` trace event, because a retry the trace does not show is a step that silently
cost twice what it appears to. `EmptyModelResponse` still fires — loudly — when the model is silent
both times.

The scripted driver has a `silence` scenario ("say nothing") reproducing the whole sequence
deterministically, so the recovery is covered without a model.

## Deferred by the spec, not debt

Streaming responses (ADR-4), remote MCP servers, trace persistence across reloads, conversation
branching and a Playwright suite are out of scope by decision, recorded in
[requirements §8](specs/webmcp-chat/requirements.md#8-deferred-scope). The `CompletionResponse` shape
in particular leaves room for streaming without a redesign.

## Open questions from the design

Carried from [design §12](specs/webmcp-chat/design.md#12-open-questions). These are decisions
awaiting a reason to be made, not defects:

1. Should the prompted-strategy system prompt be user-editable? It is the main lever for making a
   weak local model usable, which argues yes; it also makes traces harder to compare across runs.
2. Will the next WebMCP revision keep `executeTool()` returning a stringified result, or move to
   content blocks? Affects only the flattening in `host-boundary.ts`, by design.
3. Whether to record token counts — most local endpoints report `usage`, but not all.
