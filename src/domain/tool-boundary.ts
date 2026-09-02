import {
  ToolAborted,
  ToolExecutionError,
  ToolInputInvalid,
  ToolNotFound,
  ToolTimeout,
  type ToolError,
} from './errors'
import type { ToolResult } from './tool'

const ERROR_RESULT_PREFIX = 'webmcp-playground/tool-error/v1:'

type ToolErrorWire =
  | { readonly _tag: 'ToolNotFound'; readonly tool: string; readonly known: ReadonlyArray<string> }
  | {
      readonly _tag: 'ToolInputInvalid'
      readonly tool: string
      readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>
    }
  | { readonly _tag: 'ToolExecutionError'; readonly tool: string; readonly message: string }
  | { readonly _tag: 'ToolTimeout'; readonly tool: string; readonly timeoutMs: number }
  | { readonly _tag: 'ToolAborted'; readonly tool: string }

/**
 * A tool callback may cross a host that turns every rejected promise into the
 * same DOMException. The error remains on the rejection path for hosts that
 * preserve it, and the draft adapter can instead fulfil with a typed `isError`
 * result for hosts that do not. The result is JSON-safe and survives the
 * browser's stringification step.
 */
export class ToolBoundaryError extends Error {
  readonly tag: string
  readonly detail: ToolError

  constructor(error: ToolError, message: string) {
    super(message)
    this.name = 'ToolBoundaryError'
    this.tag = error._tag
    this.detail = error
  }
}

export const isToolBoundaryError = (value: unknown): value is ToolBoundaryError =>
  value instanceof ToolBoundaryError ||
  (typeof value === 'object' &&
    value !== null &&
    'tag' in value &&
    'detail' in value &&
    (value as { name?: string }).name === 'ToolBoundaryError')

const toWire = (error: ToolError): ToolErrorWire => {
  switch (error._tag) {
    case 'ToolNotFound':
      return { _tag: error._tag, tool: error.tool, known: error.known }
    case 'ToolInputInvalid':
      return { _tag: error._tag, tool: error.tool, issues: error.issues }
    case 'ToolExecutionError':
      // `cause` can be non-serialisable or circular; the structured error's own
      // fields are the portable contract across this browser boundary.
      return { _tag: error._tag, tool: error.tool, message: error.message }
    case 'ToolTimeout':
      return { _tag: error._tag, tool: error.tool, timeoutMs: error.timeoutMs }
    case 'ToolAborted':
      return { _tag: error._tag, tool: error.tool }
  }
}

/** Turns a rejected local tool execution into a value a lossy host will preserve. */
export const resultForToolBoundaryError = (cause: unknown): ToolResult | undefined => {
  if (!isToolBoundaryError(cause)) return undefined
  return {
    content: [{ type: 'text', text: `${ERROR_RESULT_PREFIX}${JSON.stringify(toWire(cause.detail))}` }],
    isError: true,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isIssues = (
  value: unknown,
): value is ReadonlyArray<{ readonly path: string; readonly message: string }> =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      isRecord(item) && typeof item.path === 'string' && typeof item.message === 'string',
  )

/**
 * Restores a typed failure only from the exact envelope this app emits. A normal
 * `isError` tool result remains a result, so user-provided tool text cannot be
 * mistaken for a host-boundary failure.
 */
export const errorFromToolBoundaryResult = (
  toolName: string,
  result: ToolResult,
): ToolError | undefined => {
  if (result.isError !== true || result.content.length !== 1) return undefined
  const text = result.content[0]?.text
  if (text === undefined || !text.startsWith(ERROR_RESULT_PREFIX)) return undefined

  let wire: unknown
  try {
    wire = JSON.parse(text.slice(ERROR_RESULT_PREFIX.length)) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(wire) || wire.tool !== toolName) return undefined

  switch (wire._tag) {
    case 'ToolNotFound':
      return isStringArray(wire.known) ? new ToolNotFound({ tool: wire.tool, known: wire.known }) : undefined
    case 'ToolInputInvalid':
      return isIssues(wire.issues)
        ? new ToolInputInvalid({ tool: wire.tool, issues: wire.issues })
        : undefined
    case 'ToolExecutionError':
      return typeof wire.message === 'string'
        ? new ToolExecutionError({ tool: wire.tool, message: wire.message })
        : undefined
    case 'ToolTimeout':
      return typeof wire.timeoutMs === 'number' && Number.isFinite(wire.timeoutMs)
        ? new ToolTimeout({ tool: wire.tool, timeoutMs: wire.timeoutMs })
        : undefined
    case 'ToolAborted':
      return new ToolAborted({ tool: wire.tool })
    default:
      return undefined
  }
}
