import type {
  DraftModelContext,
  DraftRegisteredTool,
  DraftToolDescriptor,
  DraftRegisterOptions,
  LegacyModelContext,
  LegacyTool,
} from '../spec-types'

/**
 * Spec-shaped fakes, so the conformance suite tests OUR adapters rather than
 * the browser's implementation. Skipping the draft adapter in jsdom would mean
 * the code most likely to break on a spec change is the code least tested.
 *
 * `lossyErrors` models a host that does not preserve a rejection value across
 * the boundary — the pessimistic case a real browser may well be — so the
 * degradation path in R6.8 is exercised rather than assumed.
 */
export interface FakeDraftOptions {
  readonly lossyErrors?: boolean
}

export const createFakeDraftHost = (options: FakeDraftOptions = {}): DraftModelContext => {
  const target = new EventTarget()
  const tools = new Map<string, DraftToolDescriptor>()

  const fireChange = () => target.dispatchEvent(new Event('toolchange'))

  const host: DraftModelContext = Object.assign(target, {
    registerTool: async (tool: DraftToolDescriptor, opts?: DraftRegisterOptions) => {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
        return Promise.reject(new Error(`Invalid tool name: ${tool.name}`))
      }
      if (tool.description === '') {
        return Promise.reject(new Error('description must not be empty'))
      }
      if (tools.has(tool.name)) {
        return Promise.reject(new Error(`Tool "${tool.name}" is already registered`))
      }
      tools.set(tool.name, tool)
      opts?.signal?.addEventListener('abort', () => {
        tools.delete(tool.name)
        fireChange()
      })
      fireChange()
    },

    getTools: async (): Promise<ReadonlyArray<DraftRegisteredTool>> =>
      [...tools.values()].map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        origin: 'http://localhost',
        annotations: tool.annotations,
      })),

    // Per the draft: resolves to the stringified result of execution.
    executeTool: async (
      registered: DraftRegisteredTool,
      input?: object,
      execOptions?: { signal?: AbortSignal },
    ): Promise<string> => {
      const tool = tools.get(registered.name)
      if (tool === undefined) return Promise.reject(new Error(`Unknown tool ${registered.name}`))
      const signal = execOptions?.signal ?? new AbortController().signal
      return tool
        .execute(input ?? {}, { signal })
        .then((result) => JSON.stringify(result))
        .catch((cause: unknown) =>
          Promise.reject(
            options.lossyErrors === true
              ? new Error(cause instanceof Error ? cause.message : String(cause))
              : cause,
          ),
        )
    },
  })

  return host
}

export const createFakeLegacyHost = (
  options: { readonly withReadback?: boolean } = {},
): LegacyModelContext => {
  let provided: ReadonlyArray<LegacyTool> = []
  const host: LegacyModelContext = {
    provideContext: (context) => {
      provided = context.tools
    },
  }
  if (options.withReadback === true) {
    return { ...host, getTools: () => provided }
  }
  return host
}
