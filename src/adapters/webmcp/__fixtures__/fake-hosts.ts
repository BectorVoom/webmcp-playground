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
 * The contract below is calibrated against shipping browsers, not read off the
 * prose: arguments cross as a JSON string and the result comes back stringified,
 * because that is what Chrome 152 and Edge 151 do. See
 * [browser verification](../../../../docs/browser-verification.md).
 *
 * `lossyErrors` models a host that does not preserve a rejection value, and
 * `forwardsSignal: false` a host that invokes the tool body with no options
 * argument. Both are what those browsers measurably do, so they are the
 * realistic case rather than the pessimistic one — but the optimistic host
 * stays covered too, since a future one may be kinder.
 */
export interface FakeDraftOptions {
  readonly lossyErrors?: boolean
  /** Whether the host hands the tool body an AbortSignal. Chrome and Edge do not. */
  readonly forwardsSignal?: boolean
  /** Current draft hosts take an object; early Origin Trial hosts took a JSON string. */
  readonly executeInput?: 'string' | 'object'
}

/** What a shipping browser rejects with: a DOMException, not an Error. */
const hostRejection = (name: string, message: string): unknown =>
  typeof DOMException === 'function' ? new DOMException(message, name) : new Error(message)

export const createFakeDraftHost = (options: FakeDraftOptions = {}): DraftModelContext => {
  const target = new EventTarget()
  const tools = new Map<string, DraftToolDescriptor>()

  const fireChange = () => target.dispatchEvent(new Event('toolchange'))

  const host: DraftModelContext = Object.assign(target, {
    registerTool: async (tool: DraftToolDescriptor, opts?: DraftRegisterOptions) => {
      // Chrome's and Edge's exact rejections. Note what is *not* here: neither
      // rejects an empty description, so that rule is enforced by
      // validateRegistration locally rather than by the host — and the fake
      // must not pretend otherwise, or the local check would look redundant.
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
        return Promise.reject(hostRejection('InvalidStateError', 'Invalid tool name'))
      }
      if (tools.has(tool.name)) {
        return Promise.reject(hostRejection('InvalidStateError', 'Duplicate tool name'))
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
        // Stringified on the way out, as the shipping hosts do: an object goes
        // in through registerTool and a JSON string comes back here.
        inputSchema:
          tool.inputSchema === undefined ? undefined : JSON.stringify(tool.inputSchema),
        origin: 'http://localhost',
        annotations: tool.annotations,
      })),

    // The result is stringified in both revisions. Only the in-page executeTool argument changed.
    executeTool: async (
      registered: DraftRegisteredTool,
      args?: object | string,
      execOptions?: { signal?: AbortSignal },
    ): Promise<string> => {
      const tool = tools.get(registered.name)
      if (tool === undefined) return Promise.reject(new Error(`Unknown tool ${registered.name}`))

      let input: object
      if (options.executeInput === 'object') {
        // Web IDL rejects a primitive before dispatching to the registered callback. This TypeError
        // is the safe compatibility signal: no tool body could have run, so retry cannot duplicate
        // a side effect.
        if (typeof args === 'string') throw new TypeError('inputObject must be an object')
        input = args ?? {}
      } else {
        if (typeof args !== 'string' && args !== undefined) {
          return Promise.reject(hostRejection('UnknownError', 'Failed to parse input arguments'))
        }
        try {
          input = args === undefined || args === '' ? {} : (JSON.parse(args) as object)
        } catch {
          return Promise.reject(hostRejection('UnknownError', 'Failed to parse input arguments'))
        }
      }

      // A host that forwards no options is the shipping case; the tool body
      // then has no signal to observe and cannot be cancelled through here.
      const forwarded =
        options.forwardsSignal === false
          ? undefined
          : { signal: execOptions?.signal ?? new AbortController().signal }

      return tool
        .execute(input, forwarded)
        .then((result) => JSON.stringify(result))
        .catch((cause: unknown) =>
          Promise.reject(
            options.lossyErrors === true
              ? hostRejection(
                  'UnknownError',
                  'Tool was executed but the invocation failed. For example, the script function threw an error',
                )
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
