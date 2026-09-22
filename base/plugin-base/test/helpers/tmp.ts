/**
 * Temp-home teardown that tolerates a background writer.
 *
 * `declare()` records the declaration registry fire-and-forget, so a home being removed can still
 * gain a file. Retrying keeps teardown from failing tests for a reason the test does not own.
 *
 * @module test/helpers/tmp
 */
import { rm } from 'node:fs/promises'

export async function removeHome(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  await rm(path, { recursive: true, force: true })
}
