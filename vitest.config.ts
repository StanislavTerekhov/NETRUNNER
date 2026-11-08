import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': path.join(import.meta.dirname, 'src') },
  },
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.ts', 'test/ui/**/*.test.tsx'],
    environment: 'node',
    // Component tests run in happy-dom (each file says so) with a fake IPC bridge.
    setupFiles: ['test/ui-setup.ts'],
    testTimeout: 1000 * 29,
  },
})
