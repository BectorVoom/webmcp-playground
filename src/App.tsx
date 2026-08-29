import { SessionContext } from './ui/session-context'
import { StatusBar } from './ui/status/StatusBar'
import { SelectorPane } from './ui/selector/SelectorPane'
import { ChatPane } from './ui/chat/ChatPane'
import { InspectorPane } from './ui/inspector/InspectorPane'
import { MapPane } from './ui/map/MapPane'
import type { Session } from './app/session'

/**
 * Main application layout.
 * Four panes: Selector, Chat, Inspector, and Disaster Safety MapPane.
 */
export default function App({ session }: { session: Session }) {
  return (
    <SessionContext.Provider value={session}>
      <div className="flex h-screen flex-col">
        <StatusBar />
        <main className="flex min-h-0 flex-1 overflow-hidden">
          <SelectorPane />
          <ChatPane />
          <InspectorPane />
          <div className="w-[380px] min-w-[320px] max-w-[480px] flex flex-col">
            <MapPane />
          </div>
        </main>
      </div>
    </SessionContext.Provider>
  )
}
