import { defineConfig } from 'vitest/config'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The provisioning specs must never touch the network — every archive they install is a fixture
 * served from `127.0.0.1` by the spec itself — and they must not walk the REAL `~/.avantf/tools`
 * either. `AVANTF_TOOLS_DIR` points the default managed root at a throwaway directory, and
 * `AVANTF_MEM_AUTO_DOWNLOAD=0` is the project-wide kill switch: with it set, an artifact that is not
 * already present fails instead of downloading, so a spec that forgets to point an artifact at a
 * fixture fails loudly rather than pulling a 35 MB release.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    env: {
      AVANTF_MEM_AUTO_DOWNLOAD: '0',
      AVANTF_TOOLS_DIR: join(tmpdir(), 'avantf-test-tools'),
    },
  },
})
