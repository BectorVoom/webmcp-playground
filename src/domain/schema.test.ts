import { describe, expect, it } from 'vitest'
import { Effect, Schema } from 'effect'
import { decodeToolInput, publishSchema } from './schema'
import { isValidToolName, textResult, type AnyToolDefinition } from './tool'

const defineTool = (name: string, schema: AnyToolDefinition['inputSchema']): AnyToolDefinition => ({
  name,
  description: 'test tool',
  inputSchema: schema,
  annotations: { readOnlyHint: true, untrustedContentHint: false },
  execute: () => Effect.succeed(textResult('ok')),
})

describe('publishSchema', () => {
  it('derives an object schema with required fields', () => {
    const tool = defineTool('t', Schema.Struct({ text: Schema.String }))
    const json = publishSchema(tool)
    expect(json).toMatchObject({ type: 'object', required: ['text'] })
    expect(json).not.toHaveProperty('$schema')
  })

  it('marks optional fields as not required', () => {
    const tool = defineTool(
      't',
      Schema.Struct({ a: Schema.String, b: Schema.optional(Schema.Number) }),
    )
    expect(publishSchema(tool).required).toEqual(['a'])
  })

  it('renders enums as a literal union', () => {
    const tool = defineTool('t', Schema.Struct({ p: Schema.Literal('low', 'high') }))
    const props = publishSchema(tool).properties as Record<string, { enum?: unknown[] }>
    expect(props.p?.enum).toEqual(['low', 'high'])
  })

  it('renders nested objects and arrays', () => {
    const tool = defineTool(
      't',
      Schema.Struct({
        who: Schema.Struct({ email: Schema.String }),
        tags: Schema.Array(Schema.String),
      }),
    )
    const props = publishSchema(tool).properties as Record<string, { type?: string }>
    expect(props.who?.type).toBe('object')
    expect(props.tags?.type).toBe('array')
  })
})

describe('decodeToolInput', () => {
  const tool = defineTool(
    'demo',
    Schema.Struct({ text: Schema.String, count: Schema.optional(Schema.Number) }),
  )

  it('accepts valid input', () => {
    const out = Effect.runSync(decodeToolInput(tool, { text: 'hi' }))
    expect(out).toEqual({ text: 'hi' })
  })

  it('reports the offending path for a wrong type', () => {
    const exit = Effect.runSyncExit(decodeToolInput(tool, { text: 42 }))
    expect(exit._tag).toBe('Failure')
    const error = Effect.runSync(
      Effect.flip(decodeToolInput(tool, { text: 42 })),
    )
    expect(error._tag).toBe('ToolInputInvalid')
    expect(error.issues[0]?.path).toBe('text')
  })

  it('reports a missing required field', () => {
    const error = Effect.runSync(Effect.flip(decodeToolInput(tool, {})))
    expect(error.issues.map((i) => i.path)).toContain('text')
  })

  it('reports a nested path', () => {
    const nested = defineTool('n', Schema.Struct({ who: Schema.Struct({ email: Schema.String }) }))
    const error = Effect.runSync(Effect.flip(decodeToolInput(nested, { who: { email: 1 } })))
    expect(error.issues[0]?.path).toBe('who.email')
  })
})

describe('isValidToolName', () => {
  it.each(['a', 'add-todo', 'debug.fail', 'A_1', 'x'.repeat(128)])('accepts %s', (name) => {
    expect(isValidToolName(name)).toBe(true)
  })

  it.each(['', 'x'.repeat(129), 'has space', 'emoji✨', 'slash/name'])('rejects %s', (name) => {
    expect(isValidToolName(name)).toBe(false)
  })
})
