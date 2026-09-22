import { defineConfig } from 'vitest/config'

/**
 * The conversion package is pure and offline: no model, no database, no network. Every fixture a
 * spec needs (a docx, an xlsx, a ZIP that is neither) is built in-process, so nothing here has to
 * be configured per environment.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
  },
})
