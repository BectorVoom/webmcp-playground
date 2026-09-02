/**
 * Correlation identifiers. Every trace event carries at least a SessionId, and
 * anything inside a turn carries a TurnId; tool work adds a CallId and backend
 * traffic adds a RequestId. These four are what let a coding agent join the
 * browser trace to the server log (R5.1, R5.8).
 *
 * Ids are monotonic within a session rather than random, because a human or an
 * agent reading `turn_3 / call_7` can order them at a glance, and diffing two
 * exported traces stays meaningful. The counters live in a per-session
 * `IdFactory` so that "within a session" is enforced rather than assumed.
 */

declare const brand: unique symbol

type Branded<T, B extends string> = T & { readonly [brand]: B }

export type SessionId = Branded<string, 'SessionId'>
export type TurnId = Branded<string, 'TurnId'>
export type CallId = Branded<string, 'CallId'>
export type RequestId = Branded<string, 'RequestId'>

export const newSessionId = (): SessionId =>
  `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}` as SessionId

/**
 * The counters a session numbers its turns, calls and requests from.
 *
 * One factory per session, not one per module: "monotonic within a session" is
 * the property the ids promise, and module state cannot keep that promise if a
 * document ever holds two sessions — the second would start at `turn_4` and its
 * trace would be unreadable against the first.
 */
export interface IdFactory {
  readonly newTurnId: () => TurnId
  readonly newCallId: () => CallId
  readonly newRequestId: () => RequestId
  /** Restarts the sequences, so a session reset reads `turn_1` again. */
  readonly reset: () => void
}

export const createIdFactory = (): IdFactory => {
  let turnCounter = 0
  let callCounter = 0
  let requestCounter = 0

  return {
    newTurnId: () => `turn_${++turnCounter}` as TurnId,
    newCallId: () => `call_${++callCounter}` as CallId,
    newRequestId: () => `req_${++requestCounter}` as RequestId,
    reset: () => {
      turnCounter = 0
      callCounter = 0
      requestCounter = 0
    },
  }
}

export const asSessionId = (value: string): SessionId => value as SessionId
export const asTurnId = (value: string): TurnId => value as TurnId
export const asCallId = (value: string): CallId => value as CallId
export const asRequestId = (value: string): RequestId => value as RequestId
