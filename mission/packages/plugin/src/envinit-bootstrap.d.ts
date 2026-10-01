/**
 * Resolve the framework copy the caller's tree already has.
 * @module bootstrap
 */
/** The bootstrap version; the resolved framework must satisfy {@link supportedRange}. */
export declare const VERSION = "0.3.2";
/**
 * The framework interval this bootstrap can launch.
 *
 * Kept equal to the plugins' peer range for the base: the plugin passes no override, so THIS is the
 * runtime gate. It is a plain comparator interval, NOT a caret: the package version is ordinary
 * semver again and no longer tracks the interface, so the interval stays as wide as the family's
 * compatibility promise — `>=0.3.0 <1.0.0` admits every 0.x base this generation of plugins can
 * consume, and stops at the major that invented a new interface generation. The interface itself is
 * the separate, runtime axis: a base inside this interval whose `INTERFACE_VERSION` differs is judged
 * by the base's own gate (INTERFACE.md §1, §3), which degrades rather than refusing.
 */
export declare const supportedRange = ">=0.3.0 <1.0.0";
/** Sink for the warnings that replace a throw. */
export interface BootstrapLogger {
    warn(message: string): void;
    info?(message: string): void;
}
/** What {@link ensureFramework} needs to accept the resolved copy. */
export interface EnsureFrameworkOptions {
    readonly logger?: BootstrapLogger;
    /** Override the baked {@link supportedRange}. */
    readonly supportedRange?: string;
}
/** The framework copy the caller's tree resolves to. */
export interface FrameworkLocation {
    /** A `file://` URL ready for `import()`. */
    readonly url: string;
    readonly version: string;
    readonly dir: string;
    /** Always `resolved`: the package manager's copy. */
    readonly source: 'resolved';
}
/**
 * Report the framework copy this caller's tree resolves to, or `undefined` with a warning.
 * Never throws and never installs anything.
 *
 * @param options - the logger and an optional interval override.
 * @returns the located copy, or `undefined` when it is absent or outside the interval.
 */
export declare function ensureFramework(options: EnsureFrameworkOptions): Promise<FrameworkLocation | undefined>;
/** `ensureFramework` + a dynamic `import()` of the located module; never throws. */
export declare function loadFramework<T = unknown>(options: EnsureFrameworkOptions): Promise<T | undefined>;
/**
 * Read the range a plugin declares in the nearest `package.json`: walk up from `from`,
 * preferring `peerDependencies` over `devDependencies`; `undefined` when none is found.
 */
export declare function readDependencyRange(from?: string): Promise<string | undefined>;
