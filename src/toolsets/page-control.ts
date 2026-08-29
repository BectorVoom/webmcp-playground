import { Effect, Schema } from 'effect'
import { textResult, type ToolSet } from '../domain/tool'
import { ToolExecutionError } from '../domain/errors'
import { createStore } from '../lib/store'

/**
 * R3.2 — tools whose effects are visible on the page itself. Their value is
 * pedagogical: when a mutating tool runs, you can see that it ran without
 * reading the trace, which makes a "did it actually fire?" question answerable
 * in one glance.
 */

export type Theme = 'light' | 'dark'

export const themeStore = createStore<Theme>('light')
export const highlightStore = createStore<string | null>(null)

export const applyTheme = (theme: Theme): void => {
  themeStore.set(theme)
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }
}

export const pageControlToolSet: ToolSet = {
  id: 'page-control',
  title: 'Page control',
  description: 'Mutate the page itself: theme, scrolling, and element highlighting.',
  tools: [
    {
      name: 'page.set_theme',
      title: 'Set theme',
      description: 'Switch the page between the light and dark colour themes.',
      inputSchema: Schema.Struct({ theme: Schema.Literal('light', 'dark') }),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: { theme: Theme }) =>
        Effect.sync(() => {
          applyTheme(input.theme)
          return textResult(`Theme is now ${input.theme}.`)
        }),
    },
    {
      name: 'page.get_theme',
      title: 'Get theme',
      description: 'Report which colour theme the page is currently using.',
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => Effect.sync(() => textResult(`The theme is ${themeStore.snapshot()}.`)),
    },
    {
      name: 'page.scroll_to',
      title: 'Scroll to a pane',
      description:
        'Scroll one of the three panes to its top or bottom. Panes are "chat", "selector" and "inspector".',
      inputSchema: Schema.Struct({
        pane: Schema.Literal('chat', 'selector', 'inspector'),
        position: Schema.Literal('top', 'bottom'),
      }),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: { pane: string; position: 'top' | 'bottom' }) =>
        Effect.suspend(() => {
          const element = document.querySelector<HTMLElement>(`[data-pane="${input.pane}"]`)
          if (element === null) {
            return Effect.fail(
              new ToolExecutionError({
                tool: 'page.scroll_to',
                message: `No pane named "${input.pane}" is on screen.`,
              }),
            )
          }
          element.scrollTo({ top: input.position === 'top' ? 0 : element.scrollHeight })
          return Effect.succeed(textResult(`Scrolled ${input.pane} to ${input.position}.`))
        }),
    },
    {
      name: 'page.highlight',
      title: 'Highlight an element',
      description:
        'Draw attention to the element with the given data-testid. Pass an empty string to clear.',
      inputSchema: Schema.Struct({ testId: Schema.String }),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: { testId: string }) =>
        Effect.sync(() => {
          highlightStore.set(input.testId === '' ? null : input.testId)
          return textResult(
            input.testId === '' ? 'Highlight cleared.' : `Highlighting ${input.testId}.`,
          )
        }),
    },
  ],
}
