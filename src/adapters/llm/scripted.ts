import { Effect } from 'effect'
import type { ChatMessage } from '../../domain/chat'
import type { CompletionRequest, CompletionResponse, LlmClientService } from '../../ports/LlmClient'

/**
 * A deterministic driver (R4.3), and the default when no local endpoint is
 * reachable (R4.4).
 *
 * It exists for two reasons. First, this machine may have no LLM installed at
 * all, and development must not be blocked on that. Second — and more
 * importantly — a real model makes every test flaky and every trace
 * unrepeatable, so the entire agent loop is verified against this driver, where
 * the same input always produces the same trace.
 *
 * It is stateless: the step index is derived from the number of assistant turns
 * already in the history, so replaying a conversation replays identically.
 */

export interface ScriptedStep {
  readonly text?: string | null
  /** Set where the step needs to look like a thinking model's reply. */
  readonly reasoning?: string
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly input: unknown }>
}

export interface ScriptedScenario {
  readonly id: string
  readonly description: string
  readonly keywords: ReadonlyArray<string>
  readonly steps: ReadonlyArray<ScriptedStep>
}

const lastUserMessage = (messages: ReadonlyArray<ChatMessage>): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user') return message.content
  }
  return ''
}

/** "add milk to my list" → "milk". Crude on purpose: it must be predictable, not clever. */
const extractSubject = (text: string): string => {
  const match = /\badd\b\s+(.*)$/i.exec(text)
  const raw = match?.[1] ?? text
  return raw.replace(/\b(to|on|in)\s+(my|the)\s+(todo\s+)?list\b/i, '').trim() || 'something'
}

export const SCENARIOS: ReadonlyArray<ScriptedScenario> = [
  {
    id: 'todo',
    description: 'Adds a todo, then lists the result. The happy path.',
    keywords: ['todo', 'add', 'list', 'buy'],
    steps: [
      { toolCalls: [{ name: 'todo.add', input: { text: '<subject>' } }] },
      { toolCalls: [{ name: 'todo.list', input: {} }] },
      { text: 'Done — I added it and the list is above.' },
    ],
  },
  {
    id: 'disaster',
    description: 'Reference disaster safety flow: flood zones, shelters, warnings, and routes for Tokyo.',
    keywords: ['disaster', 'flood', 'tokyo', 'shelter', 'evacuate', 'hazard'],
    steps: [
      {
        toolCalls: [
          {
            name: 'disaster.flood_forecast',
            input: { latitude: 35.6812, longitude: 139.7671, radiusKm: 20 },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'disaster.find_shelters',
            input: { latitude: 35.6812, longitude: 139.7671, radiusKm: 20, limit: 5 },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'disaster.official_alerts',
            input: { latitude: 35.6812, longitude: 139.7671 },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'disaster.evacuation_routes',
            input: { latitude: 35.6812, longitude: 139.7671, radiusKm: 20, mode: 'walk', limit: 3 },
          },
        ],
      },
      {
        text: 'DISASTER SAFETY DECISION SUPPORT:\n\n- Flood hazard map retrieved: L2 scenario zones around Chiyoda/Tokyo Station.\n- Designated safe shelters identified: Kitanomaru Park (Clear), Shiba Park (Clear), Hibiya Park (At Risk).\n- Active JMA Warnings in effect for Tokyo 23-ward area (Heavy Rain & Flood Warnings).\n- Evacuation routes computed with flood-avoidance and crossing analysis.\n\nAlways follow instructions from JMA and your local municipality.',
      },
    ],
  },
  {
    id: 'failure',
    description: 'Calls a tool that fails, then recovers and answers anyway (ADR-7).',
    keywords: ['fail', 'error', 'break'],
    steps: [
      { toolCalls: [{ name: 'debug.fail', input: { message: 'Scripted failure' } }] },
      { text: 'That tool failed, so I could not complete the request.' },
    ],
  },
  {
    id: 'hang',
    description: 'Calls a tool that never returns, to exercise timeout and cancellation.',
    keywords: ['hang', 'timeout', 'stuck', 'cancel'],
    steps: [
      { toolCalls: [{ name: 'debug.hang', input: {} }] },
      { text: 'The tool never came back.' },
    ],
  },
  {
    id: 'echo',
    description: 'A single echo round trip — the smallest useful tool call.',
    keywords: ['echo', 'repeat'],
    steps: [
      { toolCalls: [{ name: 'debug.echo', input: { text: '<subject>' } }] },
      { text: 'Echoed it back.' },
    ],
  },
  {
    id: 'silence',
    description:
      'Reasons, answers with nothing, then answers properly when nudged — the thinking-model failure.',
    keywords: ['silent', 'say nothing', 'think only'],
    steps: [
      {
        text: null,
        reasoning:
          'The user wants an answer. I should work out what to say. I have worked it out.',
      },
      { text: 'Sorry — I thought that through without saying any of it. Here is the answer.' },
    ],
  },
  {
    id: 'loop',
    description: 'Calls a tool on every step forever, to exercise the step limit (R1.5).',
    keywords: ['loop', 'forever', 'many', 'limit'],
    steps: [{ toolCalls: [{ name: 'debug.echo', input: { text: 'again' } }] }],
  },
  {
    id: 'forms',
    description: 'Submits a nested, enum-bearing form payload.',
    keywords: ['form', 'contact', 'submit'],
    steps: [
      {
        toolCalls: [
          {
            name: 'form.submit_contact',
            input: {
              name: 'Ada Lovelace',
              priority: 'high',
              contact: { email: 'ada@example.com' },
              tags: ['scripted'],
            },
          },
        ],
      },
      { text: 'Submitted the contact request.' },
    ],
  },
]

const DEFAULT_REPLY = [
  'This is the scripted driver — no model is being called, so replies are deterministic.',
  '',
  'Try one of these:',
  ...SCENARIOS.map((s) => `  • "${s.keywords[0]}…" — ${s.description}`),
].join('\n')

export const selectScenario = (message: string): ScriptedScenario | undefined => {
  const lowered = message.toLowerCase()
  return SCENARIOS.find((scenario) =>
    scenario.keywords.some((keyword) => lowered.includes(keyword)),
  )
}

export const makeScriptedClient = (): LlmClientService => ({
  id: 'scripted',
  listModels: () => Effect.succeed([{ id: 'scripted' }]),
  complete: (request: CompletionRequest): Effect.Effect<CompletionResponse> =>
    Effect.sync(() => {
      const user = lastUserMessage(request.messages)
      const scenario = selectScenario(user)
      const step = request.messages.filter((m) => m.role === 'assistant').length

      if (scenario === undefined) {
        return {
          text: DEFAULT_REPLY,
          toolCalls: [],
          raw: { driver: 'scripted', scenario: null, step },
          requestId: request.requestId,
        }
      }

      // The loop appends a system message when re-asking a step that came back
      // empty, and never otherwise — so this is how the driver tells a nudged
      // ask from a first one.
      const nudged = request.messages[request.messages.length - 1]?.role === 'system'

      // The `loop` scenario has one step and repeats it, which is what makes it
      // run into the step limit rather than terminating.
      const scripted =
        scenario.id === 'loop'
          ? scenario.steps[0]!
          : scenario.id === 'silence'
            // An empty reply adds no assistant message, so the assistant count
            // cannot advance this one. The nudge is what moves it on — which is
            // precisely the condition it exists to reproduce.
            ? scenario.steps[nudged ? 1 : 0]!
            : (scenario.steps[step] ?? { text: 'Nothing further to do.' })

      const toolCalls = (scripted.toolCalls ?? []).map((call, index) => ({
        id: `scripted_${step}_${index}`,
        name: call.name,
        input: substituteSubject(call.input, extractSubject(user)),
      }))

      return {
        text: toolCalls.length > 0 ? null : (scripted.text ?? null),
        reasoning: scripted.reasoning ?? null,
        toolCalls,
        raw: { driver: 'scripted', scenario: scenario.id, step, scripted },
        requestId: request.requestId,
      }
    }),
})

const substituteSubject = (input: unknown, subject: string): unknown => {
  if (typeof input === 'string') return input === '<subject>' ? subject : input
  if (Array.isArray(input)) return input.map((item) => substituteSubject(item, subject))
  if (typeof input === 'object' && input !== null) {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, substituteSubject(value, subject)]),
    )
  }
  return input
}
