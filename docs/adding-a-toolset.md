# Adding a tool set

A tool set is a named bundle of related tools that the selector can switch on and off as a unit.
Adding one touches its own module and one registry line (R3.8).

## Steps

**1. Create `src/toolsets/<name>.ts`** exporting a `ToolSet`:

```ts
import { Effect, Schema } from 'effect'
import { textResult, type ToolSet } from '../domain/tool'

export const weatherToolSet: ToolSet = {
  id: 'weather',
  title: 'Weather',
  description: 'Look up conditions for a city.',
  tools: [
    {
      name: 'weather.get',                    // ^[A-Za-z0-9_.-]{1,128}$
      title: 'Get the weather',
      description: 'Return current conditions for a city. Required by the spec; never empty.',
      inputSchema: Schema.Struct({
        city: Schema.String.annotations({ description: 'City name' }),
        units: Schema.optional(Schema.Literal('c', 'f')),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input: { city: string; units?: 'c' | 'f' }) =>
        Effect.succeed(textResult(`It is fine in ${input.city}.`)),
    },
  ],
}
```

**2. Register it** in [`src/toolsets/index.ts`](../src/toolsets/index.ts) by adding it to
`TOOL_SETS`. That is the only file outside your module that changes.

**3. Run `bun run check`.** Existing tests already assert that every shipped tool has a spec-legal
name, a non-empty description, and annotations that reach the host — so a malformed tool fails
without your writing a test for it.

## Conventions that earn their keep

**Declare the input schema once.** `inputSchema` is an Effect `Schema`, and both runtime validation
and the published JSON Schema derive from it (R3.5, ADR-3). Never hand-write a JSON Schema alongside
it: the two will drift, and the drift will look like a model bug.

**Annotate the schema.** `Schema.String.annotations({ description: '…' })` reaches the model as the
field description, and it is often the difference between a small model getting the shape right and
not.

**Write the description for the model, not for a developer.** It is prompt text. Say what the tool
does and when to use it. `todo.complete`'s failure message names the remedy — "Call todo.list to see
the current ids" — because the model can act on that.

**Set the annotations honestly.** `readOnlyHint: false` on anything that mutates state;
`untrustedContentHint: true` on anything returning text from outside the page. Hosts may use these
to decide whether to ask the user first.

**Fail with `ToolExecutionError`, never `throw`.** The tool body returns an `Effect`, and its failure
becomes a tool result the model can see and recover from (ADR-7). Include enough detail for the model
to do something different next time.

**Make the effect visible if you can.** `page-control` mutates the page so you can see that a tool
ran without reading the trace. A tool whose effect is invisible teaches you nothing when it
misbehaves.

**If it can fail interestingly, add it to `diagnostics` instead.** That set exists so every failure
mode is one call away on demand.

## Naming

`<set>.<verb>` — `todo.add`, `page.set_theme`, `debug.invalid_output`. Dots and underscores are legal
per the spec; spaces and slashes are not, and `isValidToolName` will reject them locally rather than
letting the host produce an opaque rejection.
