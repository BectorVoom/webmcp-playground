import { Effect, JSONSchema, ParseResult, Schema } from 'effect'
import { ToolInputInvalid } from './errors'
import type { AnyToolDefinition } from './tool'

/**
 * The bridge between the one schema declaration and its two consumers:
 * publication to the model, and validation of what comes back (R3.5).
 *
 * Keeping both here is what makes drift impossible — there is no second place
 * to edit.
 */

/**
 * JSON Schema as published to the model. `$schema` is stripped because several
 * local model servers reject it inside a tool definition, and it carries no
 * information the model can use.
 */
export const publishSchema = (tool: AnyToolDefinition): Record<string, unknown> => {
  const generated = JSONSchema.make(tool.inputSchema) as unknown as Record<string, unknown>
  const { $schema: _ignored, ...rest } = generated
  return rest
}

const pathToString = (path: ReadonlyArray<PropertyKey>): string =>
  path.map((segment) => String(segment)).join('.')

/**
 * Validate host- or model-supplied input before the tool body ever runs (R3.6).
 * Failure names the offending paths rather than dumping a formatted tree, so the
 * UI can render them as a list and an agent can machine-read them.
 */
export const decodeToolInput = (
  tool: AnyToolDefinition,
  raw: unknown,
): Effect.Effect<unknown, ToolInputInvalid> =>
  Schema.decodeUnknown(tool.inputSchema)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new ToolInputInvalid({
          tool: tool.name,
          issues: ParseResult.ArrayFormatter.formatErrorSync(parseError).map((issue) => ({
            path: pathToString(issue.path),
            message: issue.message,
          })),
        }),
    ),
  )
