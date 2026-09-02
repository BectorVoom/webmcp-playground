# Cross-browser verification

What was run, where, and what it found. Task 9.7 and tech-debt item 4.

Re-run it with:

```sh
bun run build
PORT=8791 GEO_DATA_MODE=fixture bun run server/index.ts &
bun tools/browser-verify.ts
```

The harness ([`tools/browser-verify.ts`](../tools/browser-verify.ts)) drives the **built** application
through `window.__WEBMCP_DEBUG__` — the same surface a human uses from the console — over each
browser's own automation protocol ([`tools/browser-drivers.ts`](../tools/browser-drivers.ts)): CDP for
Chrome and Edge, WebDriver BiDi for Firefox, and the `safaridriver` that ships with macOS for Safari.
No driver library is installed, which keeps the deferred-scope decision on a Playwright suite
([requirements §8](specs/webmcp-chat/requirements.md#8-deferred-scope)) from being reopened by the
back door.

## Result, 2026-09-01

| Target | WebMCP present | Adapter chosen | Verdict |
| --- | --- | --- | --- |
| Chrome 152.0.7977.65 | no | `in-memory` | pass |
| Chrome 152 `--enable-experimental-web-platform-features` | `document.modelContext` | `draft-2026-04` | pass |
| Edge 151.0.4129.107 | no | `in-memory` | pass |
| Edge 151 `--enable-experimental-web-platform-features` | `document.modelContext`, `navigator.modelContext` | `draft-2026-04` | pass |
| Firefox 154.0.1 | no | `in-memory` | pass |
| Safari 26.6.2 | no | `in-memory` | pass |

Twelve checks per target: the app boots and installs its debug handle; detection reports every
candidate with a reason; tools register and read back **from the host**; the published input schema
is an object; a tool executes and returns content blocks; tool state survives the round trip; a
structured input error retains its tag across the host; an unknown tool is refused; a full turn
completes; a failing tool is recorded as a tagged error without taking the turn down; the trace
records the turn end to end; no unexplained console or page errors.

## The premise that changed

Tech-debt item 4 recorded that "no browser on this machine implements `document.modelContext`". That
was true of the browsers as they ship. It is **not** true behind a flag: Chrome 152 and Edge 151 both
expose a real `ModelContext` under `--enable-experimental-web-platform-features`, and the app selects
the `draft-2026-04` adapter and drives it successfully.

Which means the spec adapters had been running only against our own model of the host — and that
model was wrong in four ways that no amount of jsdom testing could surface.

## What the real host does differently

Measured against Chrome 152 and Edge 151. Each of these was a live defect against a shipping browser;
all four are fixed, and the fakes in
[`__fixtures__/fake-hosts.ts`](../src/adapters/webmcp/__fixtures__/fake-hosts.ts) now reproduce the
real contract so the conformance suite would catch a regression.

1. **`executeTool(tool, args)` wants `args` as a JSON string.** An object is rejected with
   `UnknownError: Failed to parse input arguments` — a boundary *rejection*, so it reads as a failing
   tool rather than as a miscall. Every tool invocation failed before this was fixed.

2. **The `execute` callback is invoked with one argument.** There is no `options`, and therefore no
   `AbortSignal`. The adapter dereferenced `options.signal`, which threw before the tool body ran.
   A host that forwards no signal also cannot cancel a running tool through the boundary — the
   per-call timeout is what stops a hung tool there, and the conformance suite now carries a
   `supportsCancellation: false` case to say so.

3. **`inputSchema` round-trips as a string.** An object goes in through `registerTool`; a JSON string
   comes back from `getTools`. That value is handed to the model as its `parameters`, so leaving it
   stringified publishes every tool with a schema no endpoint can read — a failure that looks like
   the model ignoring the tools. Normalised now by `schemaFromHostValue`.

4. **Rejections are `DOMException`, which is not an `Error` and has no enumerable properties.**
   `JSON.stringify` renders one as `"{}"`, so the host's own explanation arrived as an empty object.
   `describeCause` in [`host-boundary.ts`](../src/adapters/webmcp/host-boundary.ts) reads `name` and
   `message` off it directly.

Two further observations, recorded but not "fixed":

- **Chrome and Edge accept an empty tool description**, which the draft forbids. `validateRegistration`
  rejects it locally first, so the rule is enforced by us rather than by the host. The fakes no longer
  pretend otherwise, or that local check would look redundant.
- **Registration errors are the host's own words**: `InvalidStateError: Duplicate tool name`,
  `InvalidStateError: Invalid tool name`. Our in-memory hosts say "already registered". The
  conformance assertion accepts either, because the property under test is that the host's message
  survives verbatim (R6.8), not which words it chose.

## Item 3, fixed

Tech-debt item 3 predicted that a real browser "may flatten [a structured rejection] to a
`DOMException`, in which case the tag is lost". It does; the adapter now avoids that lossy path.

Both Chrome and Edge answer *any* failing tool with the same opaque
`UnknownError: Tool was executed but the invocation failed. For example, the script function threw an
error` — the tool's own message included. A rejected callback therefore cannot carry structured data.
The draft adapter instead fulfils a versioned `isError` result containing the JSON-safe tagged fields,
which both browsers preserve through their stringification step; after `executeTool()` resolves, it
is decoded back to the original `ToolError`. The browser-shaped conformance case verifies that the
specific tag survives this path.

## Edge: the former rejection echo

Before the result transport, Edge reported a callback's rejection reason to `window.onerror` as well
as converting it into `UnknownError`; Chrome, given the same bare tool, stayed silent. The draft
adapter now fulfils typed failures rather than rejecting them, so the updated twelve-check harness
reports no Edge console noise while preserving the precise tag.

## Safari

Passes, on the same `in-memory` path as Firefox: WebKit implements neither `document.modelContext`
nor `navigator.modelContext`, detection says so with a reason, and the fallback carries the whole
battery.

`safaridriver` ships with macOS but refuses a session until remote automation is switched on, which
needs an administrator password and so is a one-time step per machine:

```sh
sudo safaridriver --enable      # or: Safari ▸ Settings ▸ Developer ▸ Allow Remote Automation
```

Until it is, the harness reports Safari as a loud `SKIP` carrying that reason rather than passing
over it. Safari is also the one target that cannot run headless, so expect a window to open.
