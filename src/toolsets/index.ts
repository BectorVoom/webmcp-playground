import type { ToolSet } from '../domain/tool'
import { diagnosticsToolSet } from './diagnostics'
import { formsToolSet } from './forms'
import { pageControlToolSet } from './page-control'
import { todoToolSet } from './todo'

/**
 * The tool set catalogue. Adding a set touches its own module and this file,
 * and nothing else (R3.8).
 */
export const TOOL_SETS: ReadonlyArray<ToolSet> = [
  todoToolSet,
  pageControlToolSet,
  formsToolSet,
  diagnosticsToolSet,
]

export const findToolSet = (id: string): ToolSet | undefined =>
  TOOL_SETS.find((set) => set.id === id)

export { todoStore, resetTodos } from './todo'
export { themeStore, highlightStore, applyTheme } from './page-control'
export { submissionStore } from './forms'
