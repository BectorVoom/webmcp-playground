import { Effect, Schema } from 'effect'
import { textResult, type ToolSet } from '../domain/tool'
import { ToolExecutionError } from '../domain/errors'
import { createStore } from '../lib/store'

/** R3.1 — stateful CRUD against in-page state. */

export interface TodoItem {
  readonly id: number
  readonly text: string
  readonly done: boolean
}

export const todoStore = createStore<ReadonlyArray<TodoItem>>([])

let nextId = 1

export const resetTodos = (): void => {
  todoStore.set([])
  nextId = 1
}

const describeList = (items: ReadonlyArray<TodoItem>): string =>
  items.length === 0
    ? 'The list is empty.'
    : items.map((i) => `${i.id}. [${i.done ? 'x' : ' '}] ${i.text}`).join('\n')

export const todoToolSet: ToolSet = {
  id: 'todo',
  title: 'Todo list',
  description: 'Create, list, complete and delete items in a list held in page state.',
  tools: [
    {
      name: 'todo.add',
      title: 'Add a todo',
      description: "Add a new item to the user's todo list.",
      inputSchema: Schema.Struct({
        text: Schema.String.annotations({ description: 'The text of the todo item' }),
      }),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: { text: string }) =>
        Effect.sync(() => {
          const item: TodoItem = { id: nextId++, text: input.text, done: false }
          todoStore.update((items) => [...items, item])
          return textResult(`Added todo ${item.id}: "${item.text}".`)
        }),
    },
    {
      name: 'todo.list',
      title: 'List todos',
      description: 'List every item on the todo list with its id and completion state.',
      inputSchema: Schema.Struct({}),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => Effect.sync(() => textResult(describeList(todoStore.snapshot()))),
    },
    {
      name: 'todo.complete',
      title: 'Complete a todo',
      description: 'Mark the todo item with the given id as done.',
      inputSchema: Schema.Struct({
        id: Schema.Number.annotations({ description: 'The id of the item to complete' }),
      }),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: { id: number }) =>
        Effect.suspend(() => {
          const existing = todoStore.snapshot().find((i) => i.id === input.id)
          if (existing === undefined) {
            return Effect.fail(
              new ToolExecutionError({
                tool: 'todo.complete',
                message: `No todo with id ${input.id}. Call todo.list to see the current ids.`,
              }),
            )
          }
          todoStore.update((items) =>
            items.map((i) => (i.id === input.id ? { ...i, done: true } : i)),
          )
          return Effect.succeed(textResult(`Completed todo ${input.id}.`))
        }),
    },
    {
      name: 'todo.delete',
      title: 'Delete a todo',
      description: 'Remove the todo item with the given id from the list.',
      inputSchema: Schema.Struct({ id: Schema.Number }),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: { id: number }) =>
        Effect.suspend(() => {
          const before = todoStore.snapshot().length
          todoStore.update((items) => items.filter((i) => i.id !== input.id))
          return todoStore.snapshot().length === before
            ? Effect.fail(
                new ToolExecutionError({
                  tool: 'todo.delete',
                  message: `No todo with id ${input.id}.`,
                }),
              )
            : Effect.succeed(textResult(`Deleted todo ${input.id}.`))
        }),
    },
  ],
}
