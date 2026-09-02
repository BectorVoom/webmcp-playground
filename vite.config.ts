import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import devServer from '@hono/vite-dev-server'
import { defineConfig, loadEnv } from 'vite'
import { applyEnvFile } from './server/dev-env'

// The Hono dev server plugin would otherwise intercept every request, including
// the SPA's own module graph. Hand it only `/api/*` and let Vite serve the rest.
const NON_API = /^(?!\/api).*/

/**
 * Put `.env` into `process.env` for the backend that runs inside this dev server.
 *
 * `bun run dev` loads `.env` into Bun's own process and then spawns Vite as a *child* — Node,
 * by its shebang — which inherits none of it. So `bun run start` read the file and `bun run dev`
 * silently did not, and every server-side variable was simply absent in development: the mode,
 * the LLM endpoint, the routing key. It reads as a wrong value rather than a missing one, which
 * is the expensive kind of bug.
 *
 * The empty prefix takes every key, not just `VITE_`: these are read by the backend through
 * `process.env`, never shipped to the browser. A real environment variable still wins, so
 * `GEO_DATA_MODE=live bun run dev` overrides the file as it should.
 */
const loadServerEnv = (mode: string): void => {
  applyEnvFile(loadEnv(mode, process.cwd(), ''), process.env)
}

export default defineConfig(({ mode }) => {
  loadServerEnv(mode)
  return {
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
      devServer({ entry: 'server/index.ts', exclude: [NON_API] }),
    ],
    server: { host: '127.0.0.1', port: 5173 },
  }
})
