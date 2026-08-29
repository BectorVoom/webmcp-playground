import { Effect, Schema } from 'effect'
import { textResult, type ToolSet } from '../domain/tool'
import { createStore } from '../lib/store'

/**
 * R3.3 — structured multi-field input. This set exists to stress schema
 * derivation and, more usefully, to find out what a given local model can
 * actually produce: enums, optional fields, nested objects and arrays are where
 * small models tend to fall apart, and it is better to learn that here than
 * inside a tool that matters.
 */

export interface ContactSubmission {
  readonly name: string
  readonly priority: 'low' | 'normal' | 'high'
  readonly contact: { readonly email: string; readonly phone?: string }
  readonly tags: ReadonlyArray<string>
  readonly note?: string
}

export const submissionStore = createStore<ReadonlyArray<ContactSubmission>>([])

const ContactInput = Schema.Struct({
  name: Schema.String.annotations({ description: "The person's full name" }),
  priority: Schema.Literal('low', 'normal', 'high').annotations({
    description: 'How urgent the request is',
  }),
  contact: Schema.Struct({
    email: Schema.String.annotations({ description: 'A valid email address' }),
    phone: Schema.optional(Schema.String).annotations({
      description: 'Optional phone number in any format',
    }),
  }),
  tags: Schema.Array(Schema.String).annotations({ description: 'Zero or more free-form labels' }),
  note: Schema.optional(Schema.String),
})

export const formsToolSet: ToolSet = {
  id: 'forms',
  title: 'Forms',
  description: 'Structured input: enums, optional fields, nested objects and arrays.',
  tools: [
    {
      name: 'form.submit_contact',
      title: 'Submit a contact request',
      description:
        'Submit a contact request. Requires a name, a priority of low, normal or high, a nested contact object containing an email, and a list of tags.',
      inputSchema: ContactInput,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: ContactSubmission) =>
        Effect.sync(() => {
          submissionStore.update((all) => [...all, input])
          return textResult(
            `Recorded a ${input.priority}-priority request from ${input.name} (${input.contact.email}) with ${input.tags.length} tag(s).`,
          )
        }),
    },
    {
      name: 'form.list_submissions',
      title: 'List submissions',
      description: 'List every contact request submitted so far in this session.',
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () =>
        Effect.sync(() => {
          const all = submissionStore.snapshot()
          return textResult(
            all.length === 0
              ? 'No submissions yet.'
              : all
                  .map((s, i) => `${i + 1}. ${s.name} <${s.contact.email}> [${s.priority}]`)
                  .join('\n'),
          )
        }),
    },
    {
      name: 'form.clear_submissions',
      title: 'Clear submissions',
      description: 'Delete every recorded contact request.',
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: () =>
        Effect.sync(() => {
          submissionStore.set([])
          return textResult('Cleared all submissions.')
        }),
    },
    {
      name: 'form.describe_schema',
      title: 'Describe the contact schema',
      description:
        'Return a prose description of the fields form.submit_contact expects. Useful when a model keeps sending the wrong shape.',
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () =>
        Effect.sync(() =>
          textResult(
            [
              'name: string, required',
              'priority: one of "low", "normal", "high", required',
              'contact: object, required — { email: string (required), phone: string (optional) }',
              'tags: array of strings, required (may be empty)',
              'note: string, optional',
            ].join('\n'),
          ),
        ),
    },
  ],
}
