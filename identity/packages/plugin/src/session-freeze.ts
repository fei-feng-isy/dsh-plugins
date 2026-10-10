/**
 * The identity a session starts with is the identity that session keeps.
 *
 * WHY. The system prompt is assembled before EVERY model step, and this plugin's section text is read
 * from disk at that moment. Without a freeze, editing the files (or applying a preset) mid-session
 * rewrites the prompt of a conversation that is already running: the persona changes under the reader,
 * and the request prefix changes with it, so the provider's prompt cache is thrown away for that
 * session. Neither is what a user means by "apply this identity" — they mean the next conversation.
 *
 * HOW. The assembly's `AssembleContext.scope` is the agent and `context.agent.session` is the session
 * object (`assembleContextFor` in `dsh-agent` sets both); the session object is stable for the life of a
 * session and different for the next one. Keying a `WeakMap` by it freezes per session without a
 * lifetime to manage: entries disappear with the session they belong to, so a long-running host cannot
 * accumulate them.
 *
 * An assembly with no session object (a bare probe or a unit fixture) is NOT frozen — it reads live, so
 * nothing depends on an identity that was never there.
 *
 * @module @avantf/dsh-identity/session-freeze
 */

/** One frozen string per session object. */
export class SessionFreeze {
  private readonly held = new WeakMap<object, string>()

  /**
   * The frozen text for `key`, calling `read` exactly once per key.
   *
   * @param key - the session object, or `undefined` to read live on every call.
   * @param read - reads the current text; called only when no value is held yet.
   * @returns the text this session is stuck with.
   */
  text(key: object | undefined, read: () => string): string {
    if (key === undefined) return read()
    const existing = this.held.get(key)
    // `''` is a legitimate frozen value (the switch was off when the session started), so the check is
    // against `undefined` rather than falsiness.
    if (existing !== undefined) return existing
    const value = read()
    this.held.set(key, value)
    return value
  }
}
