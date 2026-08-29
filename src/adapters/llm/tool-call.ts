import type { ChatMessage, ToolCallRequest } from '../../domain/chat'
import type { PublishedTool } from '../../domain/tool'

/**
 * Native vs prompted tool calling (R4.5).
 *
 * Native sends the `tools` parameter and reads `tool_calls` back. Prompted
 * describes the tools in a system message and parses JSON out of the reply.
 * The second exists because a great many models you can actually run on a
 * laptop do not support the first — and finding out which is which is one of
 * the questions this playground is for.
 */

export const PROMPTED_INSTRUCTION_HEADER = `You can call tools. To call one, reply with ONLY a JSON object in a \`\`\`json code block, in exactly this form:

\`\`\`json
{"tool": "<tool name>", "input": { ... }}
\`\`\`

Call one tool at a time. After the tool result comes back you may call another tool or answer normally. If no tool is needed, just answer in plain text with no JSON block.

Available tools:`

export const buildPromptedSystemMessage = (tools: ReadonlyArray<PublishedTool>): string =>
  [
    PROMPTED_INSTRUCTION_HEADER,
    ...tools.map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.inputSchema)}`,
    ),
  ].join('\n')

export const withPromptedTools = (
  messages: ReadonlyArray<ChatMessage>,
  tools: ReadonlyArray<PublishedTool>,
): ReadonlyArray<ChatMessage> =>
  tools.length === 0
    ? messages
    : [{ role: 'system', content: buildPromptedSystemMessage(tools) }, ...messages]

export interface PromptedParseResult {
  readonly toolCalls: ReadonlyArray<ToolCallRequest>
  readonly text: string | null
  readonly parseFailure?: { readonly reason: string; readonly text: string }
}

const FENCED = /```(?:json)?\s*([\s\S]*?)```/i

/**
 * Finds the first balanced JSON group, object or array, so that trailing prose
 * does not defeat the parse and a batch of calls is not silently truncated to
 * the first one.
 */
const firstBalancedGroup = (text: string): string | undefined => {
  const objectAt = text.indexOf('{')
  const arrayAt = text.indexOf('[')
  const candidates = [objectAt, arrayAt].filter((i) => i !== -1)
  if (candidates.length === 0) return undefined
  const start = Math.min(...candidates)
  const open = text[start]!
  const close = open === '{' ? '}' : ']'

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth++
    else if (char === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

const asToolCall = (value: unknown, index: number): ToolCallRequest | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  // Accept the shape we asked for, and the two shapes models produce anyway.
  const name = record.tool ?? record.name ?? record.function
  const input = record.input ?? record.arguments ?? record.parameters ?? {}
  if (typeof name !== 'string' || name === '') return undefined
  return { id: `prompted_${index}`, name, input }
}

/**
 * A model that answers in prose instead of calling a tool has not failed — it
 * has decided. So an unparseable reply becomes a final answer plus a recorded
 * finding, never an error (R4.6).
 */
export const parsePromptedResponse = (text: string | null): PromptedParseResult => {
  if (text === null || text.trim() === '') {
    return { toolCalls: [], text }
  }

  const fenced = FENCED.exec(text)
  const candidate = fenced?.[1]?.trim() ?? firstBalancedGroup(text)

  if (candidate === undefined) {
    return { toolCalls: [], text }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return {
      toolCalls: [],
      text,
      parseFailure: {
        reason: 'Found a JSON-looking block but it did not parse; treating the reply as a final answer',
        text: candidate.slice(0, 500),
      },
    }
  }

  const values = Array.isArray(parsed) ? parsed : [parsed]
  const calls = values.flatMap((value, index) => {
    const call = asToolCall(value, index)
    return call === undefined ? [] : [call]
  })

  if (calls.length === 0) {
    return {
      toolCalls: [],
      text,
      parseFailure: {
        reason: 'Parsed JSON but it named no tool; treating the reply as a final answer',
        text: candidate.slice(0, 500),
      },
    }
  }

  return { toolCalls: calls, text: null }
}
