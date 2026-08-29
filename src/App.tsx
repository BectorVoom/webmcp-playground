import { SessionContext } from './ui/session-context'
import { StatusBar } from './ui/status/StatusBar'
import { SelectorPane } from './ui/selector/SelectorPane'
import { ChatPane } from './ui/chat/ChatPane'
import { InspectorPane } from './ui/inspector/InspectorPane'
import type { Session } from './app/session'

/**
 * Three panes, all visible at once (design §7). The debugging question is
 * always "what did the model see, what did the tool do, and what came back" —
 * answering it should never require navigation.
 */
export default function App({ session }: { session: Session }) {
  return (
    <SessionContext.Provider value={session}>
      <div className="flex h-screen flex-col">
        <StatusBar />
        <main className="flex min-h-0 flex-1">
          <SelectorPane />
          <ChatPane />
          <InspectorPane />
        </main>
      </div>
    </SessionContext.Provider>
  )
}
