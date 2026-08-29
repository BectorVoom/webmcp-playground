import { describe, expect, it } from 'vitest'
import { buildPromptedSystemMessage, parsePromptedResponse, withPromptedTools } from './tool-call'

describe('parsePromptedResponse', () => {
  it('extracts a call from a fenced json block', () => {
    const result = parsePromptedResponse('```json\n{"tool":"todo.add","input":{"text":"milk"}}\n```')
    expect(result.toolCalls).toEqual([
      { id: 'prompted_0', name: 'todo.add', input: { text: 'milk' } },
    ])
    expect(result.text).toBeNull()
  })

  it('extracts a call from a bare object surrounded by prose', () => {
    const result = parsePromptedResponse(
      'Sure, I will do that. {"tool":"debug.echo","input":{"text":"hi"}} Let me know.',
    )
    expect(result.toolCalls[0]?.name).toBe('debug.echo')
  })

  it('handles braces inside strings without truncating', () => {
    const result = parsePromptedResponse('{"tool":"debug.echo","input":{"text":"a } b"}}')
    expect(result.toolCalls[0]?.input).toEqual({ text: 'a } b' })
  })

  it('accepts the name/arguments shape models emit despite instructions', () => {
    const result = parsePromptedResponse('{"name":"todo.add","arguments":{"text":"x"}}')
    expect(result.toolCalls[0]).toMatchObject({ name: 'todo.add', input: { text: 'x' } })
  })

  it('parses an array of calls', () => {
    const result = parsePromptedResponse(
      '[{"tool":"a","input":{}},{"tool":"b","input":{}}]',
    )
    expect(result.toolCalls.map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('treats plain prose as a final answer, not a failure', () => {
    const result = parsePromptedResponse('The list is empty.')
    expect(result.toolCalls).toEqual([])
    expect(result.text).toBe('The list is empty.')
    expect(result.parseFailure).toBeUndefined()
  })

  it('records a finding when a JSON block is present but broken', () => {
    const result = parsePromptedResponse('```json\n{"tool": "todo.add", "input": {oops}\n```')
    expect(result.toolCalls).toEqual([])
    expect(result.text).toContain('oops')
    expect(result.parseFailure?.reason).toContain('did not parse')
  })

  it('records a finding when JSON parses but names no tool', () => {
    const result = parsePromptedResponse('{"answer": 42}')
    expect(result.toolCalls).toEqual([])
    expect(result.parseFailure?.reason).toContain('named no tool')
  })

  it('handles a null or empty reply without inventing a failure', () => {
    expect(parsePromptedResponse(null).toolCalls).toEqual([])
    expect(parsePromptedResponse('   ').parseFailure).toBeUndefined()
  })
})

describe('withPromptedTools', () => {
  const tools = [{ name: 'debug.echo', description: 'Echo', inputSchema: { type: 'object' } }]

  it('prepends one system message describing the tools', () => {
    const messages = withPromptedTools([{ role: 'user', content: 'hi' }], tools)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('system')
    expect((messages[0] as { content: string }).content).toContain('debug.echo')
  })

  it('leaves the conversation alone when there are no tools', () => {
    const original = [{ role: 'user' as const, content: 'hi' }]
    expect(withPromptedTools(original, [])).toBe(original)
  })

  it('includes the JSON schema so the model can get the shape right', () => {
    expect(buildPromptedSystemMessage(tools)).toContain('"type":"object"')
  })
})
