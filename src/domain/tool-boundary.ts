import type { AppError } from './errors'

/**
 * Structured errors have to cross a host boundary that only understands
 * promises and strings. This carries the tag across a rejection so that, where
 * the host preserves the rejection value, we recover the precise error instead
 * of degrading everything to "the tool failed".
 *
 * Where the host does NOT preserve it — likely for a real browser
 * implementation, which may surface a DOMException instead — the adapter falls
 * back to the host's verbatim message (R6.8). Which path was taken is recorded,
 * because that fidelity gap is itself a WebMCP finding worth seeing.
 */
export class ToolBoundaryError extends Error {
  readonly tag: string
  readonly detail: AppError

  constructor(error: AppError, message: string) {
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
