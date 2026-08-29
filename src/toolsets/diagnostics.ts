import { Effect, Schema } from 'effect'
import { textResult, type ToolResult, type ToolSet } from '../domain/tool'
import { ToolExecutionError } from '../domain/errors'

/**
 * R3.4 — tools that deliberately misbehave.
 *
 * This is the most useful set in the playground. Reproducing a failure is
 * normally the expensive half of debugging an agent; here every failure mode is
 * one tool call away, on demand, with a deterministic trace. It also gives the
 * acceptance test for the project's top priority something concrete to seed
 * (task 8.9's checkpoint).
 */

const HUGE_OUTPUT_SIZE = 256 * 1024

export const diagnosticsToolSet: ToolSet = {
  id: 'diagnostics',
  title: 'Diagnostics',
  description: 'Tools that fail, hang, or return awkward output on purpose.',
  tools: [
    {
      name: 'debug.echo',
      title: 'Echo',
      description: 'Return the given text unchanged. The simplest possible round trip.',
      inputSchema: Schema.Struct({ text: Schema.String }),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input: { text: string }) => Effect.succeed(textResult(input.text)),
    },
    {
      name: 'debug.fail',
      title: 'Fail on purpose',
      description: 'Always fails, with the message you supply. Use it to exercise error paths.',
      inputSchema: Schema.Struct({
        message: Schema.optional(Schema.String),
      }),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input: { message?: string }) =>
        Effect.fail(
          new ToolExecutionError({
            tool: 'debug.fail',
            message: input.message ?? 'Deliberate failure from debug.fail',
          }),
        ),
    },
    {
      name: 'debug.slow',
      title: 'Take a while',
      description:
        'Sleep for the given number of milliseconds, then succeed. Exceed the tool timeout to see a ToolTimeout.',
      inputSchema: Schema.Struct({ ms: Schema.Number }),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input: { ms: number }) =>
        Effect.sleep(input.ms).pipe(Effect.as(textResult(`Slept for ${input.ms} ms.`))),
    },
    {
      name: 'debug.hang',
      title: 'Hang forever',
      description:
        'Never returns. Use it to exercise cancellation and the per-call timeout.',
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => Effect.never,
    },
    {
      name: 'debug.huge_output',
      title: 'Return a very large result',
      description:
        'Return roughly a quarter of a megabyte of text, to see how the transcript, the trace and the model all cope.',
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => Effect.succeed(textResult('x'.repeat(HUGE_OUTPUT_SIZE))),
    },
    {
      name: 'debug.invalid_output',
      title: 'Return a malformed result',
      description:
        'Return something that is not a valid tool result, to check that the boundary degrades gracefully instead of crashing.',
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () =>
        Effect.succeed({ content: 'this should have been an array' } as unknown as ToolResult),
    },
  ],
}
