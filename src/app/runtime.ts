import { Layer, ManagedRuntime } from 'effect'
import { MemorySinkLayer } from '../adapters/trace/memory-sink'
import type { TraceStore } from '../adapters/trace/memory-store'
import { MinimumLogLevelLayer, TraceLoggerLayer } from './logger'

/**
 * The runtime carries only what is fixed for the life of the session: the trace
 * sink and the logger wired to it (R7.6).
 *
 * The tool host and the LLM client are deliberately NOT in here. Both change at
 * runtime — that is the entire point of the selector — and rebuilding a runtime
 * on every adapter switch would tear down the trace with it. They are supplied
 * per-run instead, which keeps the trace continuous across a switch.
 */
export const appLayer = (store: TraceStore) =>
  Layer.mergeAll(MemorySinkLayer(store), TraceLoggerLayer(store), MinimumLogLevelLayer)

export type AppRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Layer.Success<ReturnType<typeof appLayer>>,
  never
>

export const createAppRuntime = (store: TraceStore): AppRuntime =>
  ManagedRuntime.make(appLayer(store))
