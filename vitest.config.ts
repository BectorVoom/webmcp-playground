import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/**/*.test.ts', 'tools/**/*.test.ts'],
        },
      },
    ],
  },
})
