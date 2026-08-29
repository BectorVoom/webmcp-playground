/** Hono context variables shared by every route. */
export interface AppEnv {
  readonly Variables: { requestId: string }
}
