import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { createSession } from './app/session'
import { installDebugHandle } from './app/debug-handle'

const session = createSession()
installDebugHandle(session)

void session.start()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App session={session} />
  </StrictMode>,
)
