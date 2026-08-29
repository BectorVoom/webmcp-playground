/**
 * Correlation identifiers. Every trace event carries at least a SessionId, and
 * anything inside a turn carries a TurnId; tool work adds a CallId and backend
 * traffic adds a RequestId. These four are what let a coding agent join the
 * browser trace to the server log (R5.1, R5.8).
 *
 * Ids are monotonic within a session rather than random, because a human or an
 * agent reading `turn_3 / call_7` can order them at a glance, and diffing two
 * exported traces stays meaningful.
 */

declare const brand: unique symbol

type Branded<T, B extends string> = T & { readonly [brand]: B }

export type SessionId = Branded<string, 'SessionId'>
export type TurnId = Branded<string, 'TurnId'>
export type CallId = Branded<string, 'CallId'>
export type RequestId = Branded<string, 'RequestId'>

let turnCounter = 0
let callCounter = 0
let requestCounter = 0

export const newSessionId = (): SessionId =>
  `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}` as SessionId

export const newTurnId = (): TurnId => `turn_${++turnCounter}` as TurnId

export const newCallId = (): CallId => `call_${++callCounter}` as CallId

export const newRequestId = (): RequestId => `req_${++requestCounter}` as RequestId

/** Test and session-reset helper: makes id sequences reproducible across runs. */
export const resetIdCounters = (): void => {
  turnCounter = 0
  callCounter = 0
  requestCounter = 0
}

export const asSessionId = (value: string): SessionId => value as SessionId
export const asTurnId = (value: string): TurnId => value as TurnId
export const asCallId = (value: string): CallId => value as CallId
export const asRequestId = (value: string): RequestId => value as RequestId
