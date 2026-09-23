/**
 * Resolve the framework copy the caller's tree already has.
 * @module bootstrap
 */
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
/** The bootstrap version; the resolved framework must satisfy {@link supportedRange}. */
export const VERSION = '0.2.0';
/**
 * The framework interval this bootstrap can launch.
 *
 * Kept equal to the plugins' peer range for the base: the plugin passes no override, so THIS is the
 * runtime gate, and a range wider than what the plugin was built against would load a base whose kit
 * it cannot use (0.2.0 is the line whose `resolveDataHome` takes the configured layer as its own
 * argument — a 0.1.x base would silently resolve the data root to a different directory).
 */
export const supportedRange = '^0.2.0';
const PACKAGE = '@avantf/dsh-plugin-base';
function parseVersion(input) {
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
    if (match === null)
        return undefined;
    const minor = match[2] === undefined ? undefined : Number(match[2]);
    const patch = match[3] === undefined ? undefined : Number(match[3]);
    const parts = patch !== undefined ? 3 : minor !== undefined ? 2 : 1;
    const pre = match[4] === undefined || match[4] === '' ? [] : match[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part));
    return { major: Number(match[1]), minor: minor ?? 0, patch: patch ?? 0, pre, parts };
}
function comparePre(a, b) {
    if (a.length === 0 && b.length === 0)
        return 0;
    if (a.length === 0)
        return 1;
    if (b.length === 0)
        return -1;
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const left = a[index];
        const right = b[index];
        if (left === undefined)
            return -1;
        if (right === undefined)
            return 1;
        if (typeof left === 'number' && typeof right === 'number') {
            if (left !== right)
                return left - right;
        }
        else if (typeof left === 'number')
            return -1;
        else if (typeof right === 'number')
            return 1;
        else if (left !== right)
            return left < right ? -1 : 1;
    }
    return 0;
}
function compare(a, b) {
    if (a.major !== b.major)
        return a.major - b.major;
    if (a.minor !== b.minor)
        return a.minor - b.minor;
    if (a.patch !== b.patch)
        return a.patch - b.patch;
    return comparePre(a.pre, b.pre);
}
function tuple(major, minor, patch) {
    return { major, minor, patch, pre: [], parts: 3 };
}
/** The next release boundary a partial `>`/`<=` desugars to. */
function bumpPartial(partial, keepPrerelease) {
    const pre = keepPrerelease ? partial.pre : [];
    if (partial.parts === 2)
        return { major: partial.major, minor: partial.minor + 1, patch: 0, pre, parts: 3 };
    return { major: partial.major + 1, minor: 0, patch: 0, pre, parts: 3 };
}
/** Expand one range token into comparators; `undefined` for a token outside the subset. */
function comparatorsOf(token) {
    const match = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(token);
    if (match === null)
        return undefined;
    const operator = match[1] ?? '';
    const partial = parseVersion(match[2] ?? '');
    if (partial === undefined)
        return undefined;
    switch (operator) {
        case '>':
            // A partial `>1.2` desugars to `>=1.3.0`.
            return partial.parts === 3 ? [{ op: '>', version: partial }] : [{ op: '>=', version: bumpPartial(partial, true) }];
        case '<=':
            // A partial `<=1.2` desugars to `<1.3.0`.
            return partial.parts === 3 ? [{ op: '<=', version: partial }] : [{ op: '<', version: bumpPartial(partial, false) }];
        case '>=':
        case '<':
            return [{ op: operator, version: partial }];
        case '':
        case '=':
            if (partial.parts === 3)
                return [{ op: '=', version: partial }];
            if (partial.parts === 2)
                return [{ op: '>=', version: partial }, { op: '<', version: tuple(partial.major, partial.minor + 1, 0) }];
            return [{ op: '>=', version: partial }, { op: '<', version: tuple(partial.major + 1, 0, 0) }];
        case '^': {
            const upper = partial.major > 0 || partial.parts === 1
                ? tuple(partial.major + 1, 0, 0)
                : partial.minor > 0 || partial.parts === 2
                    ? tuple(0, partial.minor + 1, 0)
                    : tuple(0, 0, partial.patch + 1);
            return [{ op: '>=', version: partial }, { op: '<', version: upper }];
        }
        case '~': {
            const upper = partial.parts === 1 ? tuple(partial.major + 1, 0, 0) : tuple(partial.major, partial.minor + 1, 0);
            return [{ op: '>=', version: partial }, { op: '<', version: upper }];
        }
        default:
            return undefined;
    }
}
function matchesComparator(version, comparator) {
    const order = compare(version, comparator.version);
    switch (comparator.op) {
        case '=':
            return order === 0;
        case '>':
            return order > 0;
        case '>=':
            return order >= 0;
        case '<':
            return order < 0;
        case '<=':
            return order <= 0;
    }
}
/**
 * Does `parsed` satisfy `range`? Unsupported tokens answer `false`.
 * A prerelease only matches a comparator naming a prerelease of the same tuple.
 */
function satisfies(parsed, range) {
    const text = range.trim();
    if (text === '')
        return false;
    if (text === '*')
        return true;
    return text.split('||').some(branch => {
        const tokens = branch.trim().split(/[\s,]+/).filter(token => token !== '');
        if (tokens.length === 0)
            return false;
        const comparators = [];
        for (const token of tokens) {
            const expanded = comparatorsOf(token);
            if (expanded === undefined)
                return false;
            comparators.push(...expanded);
        }
        if (!comparators.every(comparator => matchesComparator(parsed, comparator)))
            return false;
        if (parsed.pre.length === 0)
            return true;
        return comparators.some(comparator => comparator.version.pre.length > 0 &&
            comparator.version.major === parsed.major &&
            comparator.version.minor === parsed.minor &&
            comparator.version.patch === parsed.patch);
    });
}
/** Does `version` fall inside the `supported` interval? */
function withinSupported(version, supported) {
    const parsed = parseVersion(version);
    return parsed !== undefined && satisfies(parsed, supported);
}
// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────
/** Read `<dir>/package.json` as an object, or `undefined`. */
async function readManifest(dir) {
    try {
        const parsed = JSON.parse(await fsp.readFile(join(dir, 'package.json'), 'utf8'));
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/** The entry file a `package.json` points at (`.` export → `main` → `index.js`). */
function entryOf(dir, manifest) {
    const exported = manifest['exports'];
    let relative;
    if (typeof exported === 'string')
        relative = exported;
    else if (typeof exported === 'object' && exported !== null) {
        const dot = exported['.'] ?? exported;
        if (typeof dot === 'string')
            relative = dot;
        else if (typeof dot === 'object' && dot !== null) {
            const conditions = dot;
            for (const key of ['import', 'default', 'require']) {
                const value = conditions[key];
                if (typeof value === 'string') {
                    relative = value;
                    break;
                }
            }
        }
    }
    if (relative === undefined && typeof manifest['main'] === 'string')
        relative = manifest['main'];
    return join(dir, relative ?? 'index.js');
}
/**
 * Report the framework copy this caller's tree resolves to, or `undefined` with a warning.
 * Never throws and never installs anything.
 *
 * @param options - the logger and an optional interval override.
 * @returns the located copy, or `undefined` when it is absent or outside the interval.
 */
export async function ensureFramework(options) {
    const warn = (message) => {
        try {
            options.logger?.warn(`bootstrap: ${message}`);
        }
        catch {
            // The warning is best-effort.
        }
    };
    try {
        if (options.supportedRange !== undefined && typeof options.supportedRange !== 'string') {
            warn(`supportedRange must be a string; got ${typeof options.supportedRange}`);
            return undefined;
        }
        const supported = options.supportedRange ?? supportedRange;
        let dir;
        try {
            dir = dirname(createRequire(import.meta.url).resolve(`${PACKAGE}/package.json`));
        }
        catch {
            warn(`${PACKAGE} is not installed for this plugin — install it with the package manager (pnpm install)`);
            return undefined;
        }
        const manifest = await readManifest(dir);
        const version = typeof manifest?.['version'] === 'string' ? manifest['version'] : undefined;
        if (manifest === undefined || version === undefined) {
            warn(`${join(dir, 'package.json')} is missing or has no version`);
            return undefined;
        }
        if (!withinSupported(version, supported)) {
            warn(`the installed ${PACKAGE}@${version} is outside supportedRange "${supported}"; install a supported version`);
            return undefined;
        }
        return { url: pathToFileURL(entryOf(dir, manifest)).href, version, dir, source: 'resolved' };
    }
    catch (error) {
        warn(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
/** `ensureFramework` + a dynamic `import()` of the located module; never throws. */
export async function loadFramework(options) {
    try {
        const location = await ensureFramework(options);
        if (location === undefined)
            return undefined;
        return (await import(location.url));
    }
    catch (error) {
        try {
            options.logger?.warn(`bootstrap: could not load ${PACKAGE}: ${error instanceof Error ? error.message : String(error)}`);
        }
        catch {
            // best-effort
        }
        return undefined;
    }
}
/**
 * Read the range a plugin declares in the nearest `package.json`: walk up from `from`,
 * preferring `peerDependencies` over `devDependencies`; `undefined` when none is found.
 */
export async function readDependencyRange(from = process.cwd()) {
    let current = from;
    if (from.startsWith('file:')) {
        try {
            current = fileURLToPath(from);
        }
        catch {
            // A malformed `file:` URL yields no range.
            return undefined;
        }
    }
    try {
        const info = await fsp.stat(current);
        if (info.isFile())
            current = dirname(current);
    }
    catch {
        // Not an existing path: treat it as a starting directory and walk up from its parent.
        const parent = dirname(current);
        if (parent !== current)
            current = parent;
    }
    for (;;) {
        const manifestPath = join(current, 'package.json');
        let text;
        try {
            text = await fsp.readFile(manifestPath, 'utf8');
        }
        catch {
            const parent = dirname(current);
            if (parent === current)
                return undefined;
            current = parent;
            continue;
        }
        try {
            const parsed = JSON.parse(text);
            if (typeof parsed !== 'object' || parsed === null)
                return undefined;
            const manifest = parsed;
            return rangeOf(manifest['peerDependencies']) ?? rangeOf(manifest['devDependencies']);
        }
        catch {
            // The nearest manifest is unparseable: stop.
            return undefined;
        }
    }
}
function rangeOf(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const range = value[PACKAGE];
    return typeof range === 'string' && range.trim() !== '' ? range : undefined;
}
