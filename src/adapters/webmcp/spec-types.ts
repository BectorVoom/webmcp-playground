/**
 * Hand-written typings for the WebMCP host APIs. Two shapes are modelled: the
 * W3C Community Group Draft Report of 2026-04-23, and the superseded
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
  readonly execute: (input: object, options: DraftToolExecuteOptions) => Promise<unknown>
}

export interface DraftRegisterOptions {
  readonly exposedTo?: ReadonlyArray<string>
  readonly signal?: AbortSignal
}

export interface DraftRegisteredTool {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema?: object
  readonly origin?: string
  readonly annotations?: DraftToolAnnotations
}

/** `document.modelContext`, per the 2026-04-23 draft. */
export interface DraftModelContext extends EventTarget {
  registerTool(tool: DraftToolDescriptor, options?: DraftRegisterOptions): Promise<void>
  getTools(options?: object): Promise<ReadonlyArray<DraftRegisteredTool>>
  executeTool(tool: DraftRegisteredTool, input?: object, options?: object): Promise<string>
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
