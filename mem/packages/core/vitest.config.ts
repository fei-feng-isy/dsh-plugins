import { defineConfig } from 'vitest/config'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Unit tests must never touch the network or the real `~/.avantf/models` cache:
 * `AVANTF_MEM_AUTO_DOWNLOAD=0` fails model warmup fast (deterministic degraded
 * path) and the cache points at a throwaway tmp dir.
 */
export default defineConfig({
  test: {
    env: {
      AVANTF_MEM_AUTO_DOWNLOAD: '0',
      AVANTF_MEM_MODEL_CACHE: join(tmpdir(), 'avantf-test-model-cache'),
    },
    setupFiles: ['./test/setup.ts'],
  },
})
