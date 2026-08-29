# Adding a WebMCP adapter

The WebMCP draft will move again. It already has: the shape most published material describes,
`navigator.modelContext.provideContext(...)`, is not the shape in the
[April 2026 draft](https://webmachinelearning.github.io/webmcp/), which is
`document.modelContext.registerTool(tool, { signal })` with `getTools()` and `executeTool()`.

This project treats that as the normal case rather than an emergency. Supporting a new revision is
**one new module and one registry entry** — nothing in `domain/`, `ports/`, `app/` or `ui/` moves
(R6.6).

## The five steps

**1. Model the host's API surface.**
Add its interfaces to [`src/adapters/webmcp/spec-types.ts`](../src/adapters/webmcp/spec-types.ts),
including the `declare global` augmentation. This file is the only description of a host API in the
repository, and it is the first thing to change.

**2. Write the adapter.**
Create `src/adapters/webmcp/<revision>.ts` exporting a factory that returns a `ToolHostService`.
Copy the closest existing adapter. Four things are already solved for you and should not be
reimplemented:

| Concern | Where it lives |
| --- | --- |
| Validation, fault injection, timeout, cancellation, tracing | `ToolRunner` — call `runner.executeAsPromise` |
| Spec-legal name and non-empty description | `validateRegistration` in `host-boundary.ts` |
| A host that returns a string instead of content blocks | `resultFromHostValue` |
| Recovering a structured error across a rejection | `errorFromHostRejection` |

Two rules that matter more than they look:

- **Preserve the host's own error verbatim** in `ToolRegistrationError.hostMessage` (R6.8). A browser
  complaining about an unknown field is how you learn the draft moved; paraphrasing it destroys the
  only evidence.
- **`listTools` must read back from the host**, not from a local mirror, wherever the host offers a
  read-back. Where it does not — as with `provideContext` — mirror, but report `source: 'mirror'` in
  the `ToolsListed` trace event rather than pretending.

**3. Add a capability probe and a registry entry.**
In [`registry.ts`](../src/adapters/webmcp/registry.ts), add one `AdapterEntry` with its `id`,
`specRevision` (label plus a link to the revision), `probe()` and `make()`. Order is precedence.
Add the id to the `AdapterId` union in [`src/ports/ToolHost.ts`](../src/ports/ToolHost.ts).

Write the probe so that **rejection reasons are distinguishable** (R6.3). "No WebMCP in this browser"
and "WebMCP present but `registerTool` is gone" lead to completely different actions:

```ts
if (modelContext === undefined) return { supported: false, reason: 'document.modelContext is not implemented by this browser' }
if (typeof modelContext.registerTool !== 'function')
  return { supported: false, reason: 'document.modelContext exists but has no registerTool — the draft has probably moved' }
```

**4. Add it to the conformance suite.**
In [`conformance.test.ts`](../src/adapters/webmcp/conformance.test.ts), add a case to `cases`. Add a
spec-shaped fake to `__fixtures__/fake-hosts.ts` so the adapter is tested rather than skipped: an
adapter skipped in CI is the code most likely to break and least likely to be caught.

Declare the case's fidelity honestly:

- `preservesErrorTag: false` if the host flattens rejections. The suite then expects the degraded
  `ToolExecutionError` rather than the precise tag — which is the real behaviour, documented.
- `supportsCancellation: false` if the host gives the tool no signal.

**The bar: the adapter must pass the suite unchanged.** If it cannot, either the adapter is wrong or
the port genuinely needs to grow — and if it is the port, change the port deliberately and re-run
every adapter, rather than special-casing the new one.

**5. Verify.**

```bash
bun run check
```

## What NOT to do

- **Do not reference `document.modelContext` or `navigator.modelContext` outside this directory.** An
  ESLint rule fails the build if you do, and [`tools/lint-rules.test.ts`](../tools/lint-rules.test.ts)
  tests that the rule fires.
- **Do not delete the superseded adapter** when a new one lands. It is kept for pressure, not
  compatibility (ADR-5): its host replaces the entire tool set on every change and has no per-tool
  unregister, which stresses the port far harder than the current draft does. If the port can express
  both, it can probably express whatever comes next.
- **Do not widen `ToolHostService` to fit one host's quirk.** Absorb the quirk in the adapter. The
  port is written in the application's vocabulary, and every host detail admitted into it is a thing
  that must change the next time the draft does.
