import { createContext, useContext } from 'react'
import type { Session } from '../app/session'

export const SessionContext = createContext<Session | null>(null)

export const useSession = (): Session => {
  const session = useContext(SessionContext)
  if (session === null) {
    // A missing provider is a wiring bug. Saying so beats a "cannot read
    // property of null" three components deeper.
    throw new Error('useSession must be used inside a SessionContext provider')
  }
  return session
}
