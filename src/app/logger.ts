import { HashMap, List, Logger, LogLevel, Option } from 'effect'
import type { TraceStore } from '../adapters/trace/memory-store'
import type { TraceLevel } from '../domain/trace'

/**
 * One log call reaches both the browser console and the trace store (R7.5), so
 * there is never a "the console said something the trace didn't" discrepancy.
 *
 * The console half is filtered by a mutable level that the debug handle can
 * change at runtime (R5.7, R8.8); the trace half is unfiltered, because the
 * trace is the record of what happened and filtering belongs at read time.
 */

const LEVEL_ORDER: Record<TraceLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let consoleLevel: TraceLevel = 'info'

export const setConsoleLogLevel = (level: TraceLevel): void => {
  consoleLevel = level
}

export const getConsoleLogLevel = (): TraceLevel => consoleLevel

const toTraceLevel = (level: LogLevel.LogLevel): TraceLevel => {
  switch (level._tag) {
    case 'Trace':
    case 'Debug':
      return 'debug'
    case 'Warning':
      return 'warn'
    case 'Error':
    case 'Fatal':
      return 'error'
    default:
      return 'info'
  }
}

const stringify = (message: unknown): string => {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) return message.map(stringify).join(' ')
  if (message instanceof Error) return message.message
  return JSON.stringify(message) ?? String(message)
}

const CONSOLE_METHOD: Record<TraceLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
}

export const makeTraceLogger = (store: TraceStore) =>
  Logger.make<unknown, void>(({ logLevel, message, annotations, spans }) => {
    const level = toTraceLevel(logLevel)
    const text = stringify(message)
    // Effect annotations are a HashMap, not a Map — a distinction that matters
    // because the wrong one fails at runtime inside the logger, where an
    // exception is easy to lose.
    const entries = Array.from(HashMap.entries(annotations))
    const data = entries.length > 0 ? Object.fromEntries(entries) : undefined
    const annotation = (key: string): string | undefined =>
      Option.getOrUndefined(HashMap.get(annotations, key)) as string | undefined

    store.append(
      { kind: 'LogRecord', level, message: text, data },
      {
        spanName: Option.getOrUndefined(List.head(spans))?.label,
        turnId: annotation('turnId') as never,
        callId: annotation('callId') as never,
        requestId: annotation('requestId') as never,
      },
    )

    if (LEVEL_ORDER[level] >= LEVEL_ORDER[consoleLevel]) {
      const prefix = [annotation('turnId'), annotation('callId')].filter(Boolean).join('/')
        console[CONSOLE_METHOD[level]](`[webmcp${prefix ? ` ${prefix}` : ''}] ${text}`, data ?? '')
    }
  })

export const TraceLoggerLayer = (store: TraceStore) =>
  Logger.replace(Logger.defaultLogger, makeTraceLogger(store))

export const MinimumLogLevelLayer = Logger.minimumLogLevel(LogLevel.Debug)
