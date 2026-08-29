# Technical debt

Recorded deliberately, with the reasoning, so a later reader can tell a considered trade-off from an
oversight.

## Taken knowingly

**1. The inspector windows rather than virtualises.**
It renders the most recent 300 matching events with a "show older" control and an explicit
"showing N of M" count, instead of a windowing library. Meets N2 with no dependency and stays honest
about what is on screen. *Cost:* scrolling far back takes repeated clicks. *Fix when:* someone
regularly reads more than a few hundred events at a time.

**2. `ToolHostPort.subscribeToChanges` is a callback, not a `Stream`.**
The design sketched a `Stream`; the implementation uses `subscribe(listener) => unsubscribe`. The
only consumer is React's `useSyncExternalStore`, and a Stream would mean running a fiber purely to
feed a store. *Cost:* a future consumer wanting backpressure or stream combinators would need an
adapter. *Fix when:* a second consumer appears.

**3. Structured errors degrade to `ToolExecutionError` across a lossy host.**
`ToolBoundaryError` carries the tag across a promise rejection, and it survives our in-memory and
spec-shaped fake hosts. A real browser may flatten it to a `DOMException`, in which case the tag is
lost and the host's verbatim message is used instead (R6.8). This is inherent to the boundary, not a
bug — the conformance suite covers both paths explicitly (`preservesErrorTag: false`).

**4. Cross-browser verification is incomplete.**
Task 9.7 was verified on the toolchain available here: the full suite runs in jsdom, and the spec
adapters are tested against spec-shaped fakes rather than against a real `document.modelContext`,
which no browser on this machine implements. Chrome, Edge, Firefox and Safari have **not** been
manually exercised. The in-memory fallback is proven by the conformance suite, so degradation is
expected to be graceful, but it is not yet observed. *Fix when:* a browser shipping WebMCP is
available — the conformance suite already has a slot for it that skips loudly with a reason.

**5. `LlmTimeout` loses its duration across the backend boundary.**
`src/adapters/llm/local.ts` reconstructs the tag from the error body but sets `timeoutMs: 0`, because
the backend does not currently echo the configured timeout. The message and remedy are still correct.
*Fix:* add `timeoutMs` to the error body in `server/routes/llm.ts`.

**6. Turn and call ids are module-global counters.**
`newTurnId()` increments a module counter rather than a per-session one, which is why tests must call
`resetIdCounters()`. Harmless in a single-session page; it would break if two sessions ever shared a
document. *Fix when:* a second concurrent session is needed.

**7. Prompted mode is not usable with a thinking model.**
Measured against `gemma4:e4b`: the model reasons into a separate `reasoning` field and can exhaust
its output budget there, returning empty content. This now fails loudly as `EmptyModelResponse`
rather than completing with a blank answer, but the underlying limitation stands. *Possible fixes:*
raise `num_predict` per request, strip reasoning from the prompted instruction to leave more budget,
or feed the reasoning back as the answer when content is empty — the last is tempting and probably
wrong, since reasoning is internal and often trails off mid-sentence. *Decide when:* someone needs
prompted mode on a thinking model specifically.

## Deferred by the spec, not debt

Streaming responses (ADR-4), remote MCP servers, trace persistence across reloads, conversation
branching and a Playwright suite are out of scope by decision, recorded in
[requirements §8](specs/webmcp-chat/requirements.md#8-deferred-scope). The `CompletionResponse` shape
in particular leaves room for streaming without a redesign.

## Open questions from the design

Carried from [design §12](specs/webmcp-chat/design.md#12-open-questions):

1. Should the prompted-strategy system prompt be user-editable? It is the main lever for making a
   weak local model usable, which argues yes; it also makes traces harder to compare across runs.
2. Will the next WebMCP revision keep `executeTool()` returning a stringified result, or move to
   content blocks? Affects only the flattening in `host-boundary.ts`, by design.
3. Whether to record token counts — most local endpoints report `usage`, but not all.
