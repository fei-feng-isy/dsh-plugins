import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    globalSetup: ['./test/helpers/global-setup.ts'],
  },
})
