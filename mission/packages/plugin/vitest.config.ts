import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `.tsx` too: the browser half's view is rendered to static markup in its spec.
    include: ['test/**/*.spec.ts', 'test/**/*.spec.tsx'],
    environment: 'node',
  },
})
