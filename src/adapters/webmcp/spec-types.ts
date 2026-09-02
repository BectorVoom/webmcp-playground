/**
 * Hand-written typings for the WebMCP host APIs. Two shapes are modelled: the
 * current `document.modelContext` API (including the Chrome Origin Trial's
 * measured April wire behavior), and the superseded
 * `navigator.modelContext.provideContext` form that most published material
 * still describes.
 *
 * These live here, in the one directory permitted to know about host globals,
 * and are the first thing to change when the draft moves again.
 */

export interface DraftToolAnnotations {
  readonly readOnlyHint?: boolean
  readonly untrustedContentHint?: boolean
}

export interface DraftToolExecuteOptions {
  readonly signal: AbortSignal
}

export interface DraftToolDescriptor {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema?: object
  readonly annotations?: DraftToolAnnotations
  /**
   * `options` is optional because it is genuinely absent in shipping hosts:
   * Chrome 152 and Edge 151 both invoke this callback with exactly one
   * argument (measured — see docs/browser-verification.md). A host that passes
   * no signal cannot cancel a running tool, so the adapter supplies its own
   * rather than dereferencing undefined.
   */
  readonly execute: (input: object, options?: DraftToolExecuteOptions) => Promise<unknown>
}

export interface DraftRegisterOptions {
  readonly exposedTo?: ReadonlyArray<string>
  readonly signal?: AbortSignal
}

export interface DraftRegisteredTool {
  readonly name: string
  readonly title?: string
  readonly description: string
  /** Current hosts return an object; early Origin Trial hosts returned a JSON string. */
  readonly inputSchema?: object | string
  readonly origin?: string
  readonly annotations?: DraftToolAnnotations
}

/** `document.modelContext`, current draft plus the measured Origin Trial compatibility surface. */
export interface DraftModelContext extends EventTarget {
  registerTool(tool: DraftToolDescriptor, options?: DraftRegisterOptions): Promise<void>
  getTools(options?: object): Promise<ReadonlyArray<DraftRegisteredTool>>
  /**
   * The August draft takes an object. Chrome 152 and Edge 151's Origin Trial
   * implementation takes a JSON string. The adapter selects safely between the
   * two without ever retrying an invocation that reached a tool body.
   */
  executeTool(tool: DraftRegisteredTool, args?: object | string, options?: object): Promise<string>
}

/** `navigator.modelContext`, the superseded whole-set-replacement shape. */
export interface LegacyModelContext {
  provideContext(context: { tools: ReadonlyArray<LegacyTool> }): void | Promise<void>
  getTools?: () => ReadonlyArray<LegacyTool> | Promise<ReadonlyArray<LegacyTool>>
}

export interface LegacyTool {
  readonly name: string
  readonly description: string
  readonly inputSchema?: object
  readonly execute: (input: object) => Promise<unknown>
}

declare global {
  interface Document {
    readonly modelContext?: DraftModelContext
  }
  interface Navigator {
    readonly modelContext?: LegacyModelContext
  }
}
