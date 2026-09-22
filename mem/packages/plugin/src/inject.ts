/**
 * The services this plugin injects.
 *
 * Kept out of `index.ts` so the compatibility spec's coverage of this list is unit-testable without
 * dragging the whole plugin entry (and its host peers) into the test process — see
 * `test/provision.spec.ts`, which asserts that every service cordis WAITS for has a contract in
 * `SERVICE_CONTRACTS`.
 *
 * `systemPrompt` is here because the plugin contributes three usage sections and two conditional
 * hints (see `prompt.ts`). Each service gates `apply`: without `tools`/`typert` there is nothing to
 * register, and without the prompt registry the guidance has nowhere to land.
 */
export const inject = ['tools', 'typert', 'systemPrompt']
