# Traceability audit

Task 9.5. Every criterion in [`requirements.md`](./requirements.md) mapped to its evidence.

- **Auto** — an automated test asserts it. File named.
- **Verified** — exercised and observed during implementation, but not asserted by a test.
- **Gap** — not verified. Listed honestly rather than quietly claimed.

`bun run check` at the time of writing: types clean, lint clean, **222 passed / 1 skipped**.
The single skip is the real-browser adapter slot, which skips with a printed reason by design.

## R1 — Chat interface

| ID | Status | Evidence |
| --- | --- | --- |
| R1.1 | Auto | `agent-loop.test.ts` "completes a multi-step turn"; `ui.test.tsx` "renders a turn with inline tool calls" |
| R1.2 | Auto | `ui.test.tsx` "disables sending until there is something to send"; cancel replaces send while running (`ChatPane.tsx`) |
| R1.3 | Auto | `agent-loop.test.ts` "cancels an in-flight turn when the signal fires" |
| R1.4 | Auto | `agent-loop.test.ts` "completes a multi-step turn" (two tool calls, three model calls) |
| R1.5 | Auto | `agent-loop.test.ts` "stops at the step limit and keeps the partial transcript" |
| R1.6 | Auto | `ui.test.tsx` "renders a turn with inline tool calls, durations and results" |
| R1.7 | Auto | `session.test.ts` "replays a step-limited turn from its originating user message", "drops any turns that followed the one being retried" |
| R1.8 | Auto | `debug-handle.test.ts` "clears transcript and trace on reset" |

## R2 — WebMCP selector

| ID | Status | Evidence |
| --- | --- | --- |
| R2.1 | Auto | `ui.test.tsx` "lists every tool set with its tool count" |
| R2.2 | Auto | `tool-registry.test.ts` "registers every tool in an enabled set", "reports per-tool registration outcomes" |
| R2.3 | Auto | `tool-registry.test.ts` "unregisters the whole set on disable"; `ui.test.tsx` "unregisters a set on untoggle" |
| R2.4 | Auto | `conformance.test.ts` "registers a tool and reads it back from the host"; `agent-loop.test.ts` "records the tools the model was offered at every step, read from the host" |
| R2.5 | Auto | `conformance.test.ts` "notifies subscribers when the tool set changes"; `ui.test.tsx` "registers a set on toggle and shows the tools read back from the host" |
| R2.6 | Auto | `tool-registry.test.ts` "refuses a set that would duplicate a name, naming both owners" and "leaves the host untouched when it refuses" |
| R2.7 | Auto | `ui.test.tsx` "exposes the published JSON schema for a registered tool" |
| R2.8 | Auto | `config.test.ts` round-trip; `session.test.ts` "restores the tool set selection", "writes the selection back", "honours a forced adapter" |

## R3 — Tool sets

| ID | Status | Evidence |
| --- | --- | --- |
| R3.1–R3.4 | Auto | `tool-registry.test.ts` "registers every shipped set without a name collision"; each set exercised via `agent-loop.test.ts` and `debug-handle.test.ts` |
| R3.5 | Auto | `schema.test.ts` (derivation) + `decodeToolInput` from the same declaration |
| R3.6 | Auto | `conformance.test.ts` "rejects input that does not satisfy the schema, without running the body"; `agent-loop.test.ts` "rejects model-supplied input that violates the schema" |
| R3.7 | Auto | `tool-registry.test.ts` "propagates annotations to the host for every tool" |
| R3.8 | Auto | `tool-registry.test.ts` "gives every shipped tool a spec-legal name"; enforced structurally by `toolsets/index.ts` |

## R4 — Local LLM integration

| ID | Status | Evidence |
| --- | --- | --- |
| R4.1 | Auto | `config.test.ts` defaults to `http://localhost:11434/v1`; URL scheme validated |
| R4.2 | Auto | `local.ts` only ever calls `/api/*`; verified by the offline check below (N4) |
| R4.3 | Auto | `debug-handle.test.ts` driver selection; `scripted.ts` and `local.ts` both implement the port |
| R4.4 | Auto | `debug-handle.test.ts` "falls back to the scripted driver and says why"; `ui.test.tsx` "tells the user plainly that no local LLM was reachable" |
| R4.5 | Auto | `tool-call.test.ts` (12 cases across both strategies); `tools-unsupported.test.ts` classifies a model with no tool template and points at the prompted strategy |
| R4.6 | Auto | `tool-call.test.ts` "treats plain prose as a final answer, not a failure" and the two parse-failure cases; `agent-loop.test.ts` "fails explicitly when the model returns neither text nor a tool call" |
| R4.7 | Auto | `routes.test.ts` "returns an empty list rather than a 500 when upstream is down" |
| R4.8 | Auto | `upstream.test.ts` (5 cases on a virtual clock): retries a transport failure exactly twice, succeeds on recovery, does **not** retry a non-2xx or an unparseable body, and times out |
| R4.9 | Auto | `routes.test.ts` "maps an unreachable upstream to 502 with a remedy"; `tools-unsupported.test.ts` "surfaces through the route as 400 with the tag and the remedy"; `errors.test.ts` remedies |

## R5 — Observability and debuggability

| ID | Status | Evidence |
| --- | --- | --- |
| R5.1 | Auto | `memory-store.test.ts` (seq, correlation, cap); every loop test asserts on trace events |
| R5.2 | Auto | `ui.test.tsx` "shows trace events with sequence numbers and summaries", "filters by category" |
| R5.3 | Auto | `agent-loop.test.ts` "carries verbatim model output into the trace"; `ui.test.tsx` "exposes the verbatim JSON of an event" |
| R5.4 | Verified | `CopyButton` on event, turn and whole trace. Clipboard not asserted (jsdom has no clipboard). |
| R5.5 | Auto | `debug-handle.test.ts` "round-trips a trace through export and import"; `trace-replay.test.ts` (7 cases) |
| R5.6 | Auto | `routes.test.ts` "writes a well-formed trace and reports where it went" |
| R5.7 | Auto | `runtime.test.ts` "routes Effect logs into the trace store" |
| R5.8 | Auto | `server/request-id.test.ts` (sent by driver, echoed by backend, generated when absent) |
| R5.9 | Auto | `debug-handle.test.ts` (12 cases covering every entry point) |
| R5.10 | Auto | `agent-loop.test.ts` "surfaces an injected fault"; `debug-handle.test.ts` "lets an agent seed a fault and find the event that explains it" |
| R5.11 | Verified | Every interactive element carries a `data-testid`; the UI suite queries exclusively by test id, so a missing one fails a test. |
| R5.12 | Auto | `ui.test.tsx` "reports adapter, driver, tool count and turn state at a glance" |
| R5.13 | Auto | `errors.test.ts` "produces a non-empty, object-free message for every sample"; `ui.test.tsx` "shows a tool failure with its tag" and "names the tools that DO exist" |

## R6 — Adaptability to spec change

| ID | Status | Evidence |
| --- | --- | --- |
| R6.1 | Auto | `tools/lint-rules.test.ts` — the rule is tested, not just configured |
| R6.2 | Auto | `conformance.test.ts` runs 5 adapter configurations (in-memory, draft, draft-lossy, legacy, legacy-with-readback) |
| R6.3 | Auto | `detect.test.ts` "distinguishes 'no WebMCP' from 'WebMCP without registerTool'"; `ui.test.tsx` renders the reasons |
| R6.4 | Auto | `detect.test.ts` "honours an explicit override and says that it did" |
| R6.5 | Auto | `conformance.test.ts` — 14 assertions × 5 configurations |
| R6.6 | Verified | Registry is one entry per adapter; documented in `docs/adding-an-adapter.md`. Structurally true, not asserted. |
| R6.7 | Auto | `conformance.test.ts` "reports a spec revision"; shown in the status bar |
| R6.8 | Auto | `conformance.test.ts` "rejects a duplicate name and preserves the host message"; the `lossyErrors` configuration exercises the degradation path |

## R7 — Error handling and logging

| ID | Status | Evidence |
| --- | --- | --- |
| R7.1 | Auto | `tools/lint-rules.test.ts` "rejects throw in the domain, ports and app layers" |
| R7.2 | Auto | `errors.test.ts`; `describeError`/`remedyFor` are exhaustive switches — a new tag is a compile error |
| R7.3 | Verified | `Effect.exit` distinguishes failure from defect in `tool-runner.ts`; a defect renders through the `Defect` trace kind. Not asserted. |
| R7.4 | Verified | `timedSpan` wraps turn, model call and tool call; durations appear in trace events and in the UI (asserted indirectly by `ui.test.tsx` "durations"). |
| R7.5 | Auto | `runtime.test.ts` (both halves of the fan-out) |
| R7.6 | Auto | `runtime.test.ts` "provides the trace sink to effects that ask for it"; tests substitute layers throughout |
| R7.7 | Auto | `tool-registry.test.ts` "moves live registrations to a new host on rebind, leaving none behind"; `session.test.ts` "carries the live tool sets across a host switch" |

## R8 — Backend

| ID | Status | Evidence |
| --- | --- | --- |
| R8.1 | Auto | `routes.test.ts` covers all four routes |
| R8.2 | Auto | `routes.test.ts` "returns 200 even when the local LLM is unreachable, and says so" |
| R8.3 | Auto | `routes.test.ts` "rejects a malformed body with 400", "rejects a missing body" |
| R8.4 | Verified | One JSON line per request, observed in the dev and production smoke runs. |
| R8.5 | Auto | `config.test.ts` (7 cases, each naming the offending variable) |
| R8.6 | Verified | Binds `127.0.0.1`; CORS limited to the two dev origins. Observed, not asserted. |
| R8.7 | Auto | `routes.test.ts` "refuses a session id that could escape the trace directory", "refuses an over-long session id" |

## R9 — Developer experience

| ID | Status | Evidence |
| --- | --- | --- |
| R9.1 | Verified | `bun run dev` serves SPA and `/api/health` from one process — smoke-tested. |
| R9.2 | Auto | `bun run check` is green |
| R9.3 | Auto | The whole suite runs with no LLM installed; `debug-handle.test.ts` asserts the fallback. README documents installation. |
| R9.4 | Verified | README "Debugging with a coding agent"; the loop it describes is asserted by `debug-handle.test.ts`. |

## Non-functional

| ID | Status | Evidence |
| --- | --- | --- |
| N1 | Auto | `debug-handle.test.ts` "adds under 5 ms per trivial tool call" (100 calls, warmed) |
| N2 | Auto | `memory-store.test.ts` "drops the oldest events past the cap and counts the loss"; inspector windows to 300 |
| N3 | Auto (partial) | `ui.test.tsx` "announces the transcript as a live region"; keyboard operability uses native controls and a visible `:focus-visible` ring, not separately asserted |
| N4 | Verified | Runtime `fetch` targets are `/api/health`, `/api/traces` and the configured local URL only. External strings in the bundle are spec links and library constants, not requests. |
| N5 | Verified | `.env` and `.traces/` git-ignored; no secret in source |
| N6 | **Gap** | See below |

## Gaps

1. **N6 / task 9.7 — cross-browser verification.** Not performed. No browser on this machine
   implements WebMCP, and Chrome/Edge/Firefox/Safari were not manually exercised. The in-memory
   fallback is proven by the conformance suite, so degradation should be graceful, but it has not
   been observed. The conformance suite already has a real-browser slot that skips with a printed
   reason.

That is the only outstanding gap. Two earlier ones — the untested retry schedule (R4.8) and the
unasserted turn retry (R1.7) — were found by this audit and closed: see `server/upstream.test.ts`
and `src/app/session.test.ts`.
