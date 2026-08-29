import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import devServer from '@hono/vite-dev-server'
import { defineConfig } from 'vite'

// The Hono dev server plugin would otherwise intercept every request, including
// the SPA's own module graph. Hand it only `/api/*` and let Vite serve the rest.
const NON_API = /^(?!\/api).*/

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    devServer({ entry: 'server/index.ts', exclude: [NON_API] }),
  ],
  server: { host: '127.0.0.1', port: 5173 },
})
