import { Effect, Stream } from 'effect'

/**
 * Turns a host's push notification into a scoped Effect stream. Each consumer
 * owns its listener, and interrupting its fiber removes that listener.
 */
export const fromChangeSubscription = (
  subscribe: (listener: () => void) => () => void,
): Stream.Stream<void> =>
  Stream.asyncPush<void>((emit) =>
    Effect.acquireRelease(
      Effect.sync(() => subscribe(() => void emit.single(undefined))),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  )
