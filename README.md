# WebMCP Test Chat Page

A local playground for exercising the [WebMCP](https://webmachinelearning.github.io/webmcp/)
browser API. The page acts as a **tool provider** — it registers tool sets with the browser's
model-context registry — and embeds its own **agent**, a chat interface backed by a local LLM, which
discovers and invokes those tools. That closes the loop inside one page, so WebMCP behaviour can be
tested without an agentic browser and in browsers that do not implement the API at all.

The intended reader of its output is a coding agent, so everything the system does is recorded as a
typed, exportable trace rather than as log lines.

Specs live in [`docs/specs/webmcp-chat/`](docs/specs/webmcp-chat/): requirements, design, tasks.

## Quick start

```bash
bun install
bun run dev        # SPA + API in one process, one log stream, at http://127.0.0.1:5173
```

**No LLM is required to start.** With nothing installed the app selects a deterministic *scripted*
driver and says so in the banner; the whole tool-calling loop still runs. Try:

| Say | What happens |
| --- | --- |
| `add milk` | calls `todo.add`, then `todo.list`, then answers |
| `please fail` | calls a tool that fails, then recovers and answers anyway |
| `hang please` | calls a tool that never returns — exercises timeout and cancel |
| `loop forever` | calls a tool every step until the step limit stops it |
| `submit a contact form` | nested object, enum and array input |

## Using a real local model

Any OpenAI-compatible `/v1` endpoint works. Install one, then point `LLM_BASE_URL` at it:

```bash
cp .env.example .env
```

| Runtime | Install | Default base URL |
| --- | --- | --- |
| [Ollama](https://ollama.com) | `ollama serve && ollama pull gemma4:e4b` | `http://localhost:11434/v1` |
| [LM Studio](https://lmstudio.ai) | app → Developer → Start Server | `http://localhost:1234/v1` |
| llama.cpp | `brew install llama.cpp && llama-server -m model.gguf` | `http://localhost:8080/v1` |
| vLLM | `vllm serve <model>` | `http://localhost:8000/v1` |

Reload; the status bar switches to `driver local` and the model picker fills in. If it does not,
`curl localhost:5173/api/health` says exactly why — that endpoint always returns 200 and puts the
diagnosis in the body, because a health check that fails when the thing it reports on is down tells
you nothing.

**Tool calling on small models.** Many local models have no tool-calling template at all — the whole
Gemma family included. The selector has a *tool-call strategy* switch: `native` sends the `tools`
request parameter, `prompted` describes the tools in a system message and parses JSON out of the
reply.

If the model cannot do native tool calls, you will not have to guess: the endpoint says so, and the
app surfaces it as `ModelLacksToolSupport` with the remedy attached, rather than as an opaque request
failure. Switch the strategy to `prompted` and the same tools work.

### Measured: `gemma4:e4b` on an M1 Mac mini (16 GB)

Actual runs through the agent loop, not estimates. `ollama show` reports `tools` and `thinking`
capabilities; the model is 8 B parameters at Q4_K_M, ~9.6 GB.

| Scenario | Strategy | Result |
| --- | --- | --- |
| add a todo, then list it | native | ✅ 2 steps, 2 tool calls, ~30 s |
| nested object + enum + array (`form.submit_contact`) | native | ✅ correct payload first try, ~36 s |
| tool fails, model must recover | native | ✅ read the error and explained it, ~21 s |
| add a todo, then list it | prompted | ⚠️ unreliable — see below |

Two findings worth knowing before you trust a run:

- **Native tool calling is solid**, including nested objects, enums and arrays. Roughly 8–16 s per
  model call on this hardware, so a two-step turn is about half a minute.
- **Prompted mode is unreliable with a thinking model.** gemma4 reasons in a separate `reasoning`
  field, and can spend its entire output budget there and return empty content. The app now reports
  that as `EmptyModelResponse` with a remedy rather than completing the turn with a blank answer —
  but the practical advice is to use `native` with this model.

The model's reasoning is captured on every response and shown in the inspector under **model
reasoning**. It is the most direct evidence available for whether a tool *description* is doing its
job — you can read exactly why a tool was or was not chosen.

## Debugging with a coding agent

This is what the project is for. The loop is: **run → drive → save → read a file.** No screenshots,
no DOM scraping.

```js
const d = window.__WEBMCP_DEBUG__
d.help()                                  // every entry point, plus the scripted scenarios

await d.setToolSets(['diagnostics'])
d.injectFault({ kind: 'fail', count: 1 }) // arm the next tool call to fail
const turn = await d.sendMessage('echo hello')
await d.waitForIdle()

d.getTrace({ turnId: turn.id, kinds: ['ToolCallFailed'] })
await d.saveTrace()                       // → { path: '.traces/sess_xxx.json' }
```

Then, from the shell:

```bash
cat .traces/sess_*.json | jq '.events[] | select(.payload.kind == "ToolCallFailed")'
```

Two entry points are worth knowing about specifically:

- **`d.callTool(name, input)`** invokes a tool with the model bypassed entirely. It separates *the
  tool is broken* from *the model called the tool wrong* — normally the most expensive ambiguity in
  agent debugging.
- **`d.getTools()`** reads back from the host rather than from local state, so a divergence between
  what was registered and what the host actually holds is visible rather than assumed away.

Every interactive element carries a stable `data-testid` of the form `<area>-<element>-<qualifier>`
(`chat-input-message`, `selector-toolset-toggle-todo`, `inspector-filter-model`).

Configuration lives in the URL, so a link reproduces a configuration exactly:

```
http://127.0.0.1:5173/?toolSets=diagnostics&adapter=in-memory&driver=scripted&strategy=prompted&maxSteps=3
```

## What is on screen

```
status bar: adapter · spec revision · driver · model · backend · tool count · turn state
┌─ selector ────────┬─ chat ──────────────────┬─ inspector ──────────┐
│ tool sets         │ transcript with inline  │ every trace event,   │
│ registered tools  │ tool calls, durations,  │ filterable, with     │
│ (read from host)  │ results and errors      │ verbatim JSON        │
│ adapter / driver  │                         │                      │
│ fault injection   │ composer + cancel       │ copy event/turn/all  │
└───────────────────┴─────────────────────────┴──────────────────────┘
```

All three panes are visible at once on purpose: the debugging question is always *what did the model
see, what did the tool do, and what came back*, and answering it should never require navigation.

## Architecture in one paragraph

WebMCP tools execute in page context, so the agent loop runs in the browser too; the Hono backend is
a thin credential boundary and OpenAI-dialect normaliser, not an orchestrator. All host access goes
through one port, `ToolHostPort`, with three adapters behind it — the current draft
(`document.modelContext`), the superseded `navigator.modelContext` shape, and an in-memory host — and
an ESLint rule prevents anything outside `src/adapters/webmcp/` from naming a host global. A shared
conformance suite runs against every adapter. See [design.md](docs/specs/webmcp-chat/design.md).

## Commands

| Command | Does |
| --- | --- |
| `bun run dev` | SPA and API together, one process |
| `bun run check` | types, lint and tests — the gate |
| `bun run test` / `test:watch` | tests only |
| `bun run build` | type-check and build the SPA to `dist/` |
| `bun run start` | serve `dist/` and the API from the backend alone |

## Configuration

All backend settings are environment variables; see [`.env.example`](.env.example). A malformed value
stops startup with the variable named, rather than surfacing three layers down as a confusing fetch
error.

## Extending it

- [Adding a WebMCP adapter](docs/adding-an-adapter.md) — what to do when the spec moves again.
- [Adding a tool set](docs/adding-a-toolset.md).
- [Known technical debt](docs/tech-debt.md).

## Requirements

Node 18+ or Bun (developed on Bun 1.3). macOS; nothing is macOS-specific. No network access is needed
at runtime once dependencies are installed.
