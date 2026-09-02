import { Effect } from 'effect'
import {
  ToolExecutionError,
  ToolRegistrationError,
  type ToolError,
} from '../../domain/errors'
import { isToolBoundaryError } from '../../domain/tool-boundary'
import { isValidToolName, type AnyToolDefinition, type ToolResult } from '../../domain/tool'
import type { AdapterId } from '../../ports/ToolHost'

/**
 * Shared boundary handling. Every adapter faces the same two problems — a host
 * that speaks promises and strings rather than typed errors and content blocks —
 * so both are solved once, here.
 */

/**
 * The host's own words for a rejection, whatever it chose to throw.
 *
 * `DOMException` needs its own arm: it is not an `Error` subclass and carries
 * no enumerable own properties, so `JSON.stringify` renders it `"{}"`. That is
 * the shape a shipping browser actually rejects with — Chrome 152 and Edge 151
 * both answer a failed tool with `UnknownError: Tool was executed but the
 * invocation failed…` — so without this the one message that explains the
 * failure would arrive as an empty object.
 */
const describeCause = (cause: unknown): string | undefined => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  if (typeof cause === 'object' && cause !== null) {
    const { name, message } = cause as { name?: unknown; message?: unknown }
    if (typeof message === 'string' && message !== '') {
      return typeof name === 'string' && name !== '' ? `${name}: ${message}` : message
    }
  }
  return undefined
}

/** Rejected as a string; recovered as a tag where the host preserved it (R6.8). */
export const errorFromHostRejection = (toolName: string, cause: unknown): ToolError => {
  if (isToolBoundaryError(cause)) return cause.detail as ToolError
  const message = describeCause(cause) ?? JSON.stringify(cause) ?? String(cause)
  return new ToolExecutionError({ tool: toolName, message, cause })
}

/**
 * The April 2026 draft specifies `executeTool()` as resolving to a stringified
 * result, while the same document's `execute` callback returns content blocks.
 * We accept either, and never lose the host's value: an unrecognised shape
 * becomes the text of a single content block rather than an error, so a spec
 * change here degrades to "the output looks odd" instead of "everything broke".
 */
export const resultFromHostValue = (raw: unknown): ToolResult => {
  if (typeof raw === 'object' && raw !== null && Array.isArray((raw as ToolResult).content)) {
    return raw as ToolResult
  }
  if (typeof raw === 'string') {
    const parsed = tryParseJson(raw)
    if (parsed !== undefined && Array.isArray((parsed as ToolResult).content)) {
      return parsed as ToolResult
    }
    return { content: [{ type: 'text', text: raw }] }
  }
  return { content: [{ type: 'text', text: JSON.stringify(raw) ?? String(raw) }] }
}

/**
 * A tool's input schema as read back from the host.
 *
 * Chrome 152 and Edge 151 store the schema stringified: an object goes in via
 * `registerTool` and a JSON string comes back out of `getTools`. That value is
 * handed straight to the model as its `parameters`, so leaving it as a string
 * publishes every tool with a schema no endpoint can read — a failure that
 * looks like the model ignoring the tools rather than like a type error.
 */
export const schemaFromHostValue = (raw: unknown): object | undefined => {
  if (typeof raw === 'string') {
    const parsed = tryParseJson(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as object) : undefined
  }
  return typeof raw === 'object' && raw !== null ? (raw as object) : undefined
}

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Local checks that would otherwise surface as an opaque host rejection. Better
 * a precise local failure than a browser's paraphrase of one.
 */
export const validateRegistration = (
  tool: AnyToolDefinition,
  adapter: AdapterId,
): Effect.Effect<void, ToolRegistrationError> => {
  if (!isValidToolName(tool.name)) {
    return Effect.fail(
      new ToolRegistrationError({
        tool: tool.name,
        adapter,
        hostMessage: `Name must match ${'[A-Za-z0-9_.-]{1,128}'} per the WebMCP spec`,
      }),
    )
  }
  if (tool.description.trim() === '') {
    return Effect.fail(
      new ToolRegistrationError({
        tool: tool.name,
        adapter,
        hostMessage: 'Description is required and may not be empty per the WebMCP spec',
      }),
    )
  }
  return Effect.void
}

export const hostMessageOf = (cause: unknown): string =>
  describeCause(cause) ?? JSON.stringify(cause) ?? String(cause)
