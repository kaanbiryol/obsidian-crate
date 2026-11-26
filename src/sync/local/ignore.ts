import { isConflictFile } from '../conflict/conflict';
import { createLogger } from '../logger';
import { errorMessage } from '../../platform/logger';

const logger = createLogger('SyncEngine');

export interface IgnoreMatcherContext {
	ignoredDirPrefixes: string[];
	ignorePatterns: string[];
	patternCache: Map<string, RegExp>;
}

/** Configured patterns plus folders the host owns; directory patterns join the prefixes. */
export function createIgnoreMatcherContext(
	fixedPrefixes: string[],
	ignorePatterns: string[],
	patternCache = new Map<string, RegExp>(),
): IgnoreMatcherContext {
	return {
		ignoredDirPrefixes: [...new Set([...fixedPrefixes, ...ignorePatterns.filter(pattern => pattern.endsWith('/'))])],
		ignorePatterns,
		patternCache,
	};
}

function patternSource(pattern: string): string {
	return Array.from(pattern).map(char => {
		if (char === '*') return '.*';
		if (char === '?') return '.';
		return char.replace(/[\\^$+.|(){}[\]]/g, '\\$&');
	}).join('');
}

function compilePattern(pattern: string): RegExp | null {
	try {
		return new RegExp(`^${patternSource(pattern)}$`);
	} catch (error) {
		logger.warn(`Invalid ignore pattern "${pattern}":`, errorMessage(error));
		return null;
	}
}

/** A context's file patterns joined into one expression per kind, so each path costs two
 * tests instead of two per pattern: patterns with a `/` match the whole path, the others
 * also match the file name. */
interface CompiledPatterns { patterns: string[]; withSlash: RegExp | null; anyName: RegExp | null }
const compiled = new WeakMap<IgnoreMatcherContext, CompiledPatterns>();

function compiledPatterns(context: IgnoreMatcherContext): CompiledPatterns {
	let value = compiled.get(context);
	// A pattern list edited in place compiles again.
	if (value && value.patterns.length === context.ignorePatterns.length
		&& value.patterns.every((pattern, index) => pattern === context.ignorePatterns[index])) return value;
	const join = (patterns: string[]) => {
		const valid = patterns.filter(pattern => compilePattern(pattern));
		return valid.length ? new RegExp(`^(?:${valid.map(patternSource).join('|')})$`) : null;
	};
	const files = context.ignorePatterns.filter(pattern => !pattern.endsWith('/'));
	value = { patterns: [...context.ignorePatterns], withSlash: join(files.filter(pattern => pattern.includes('/'))),
		anyName: join(files.filter(pattern => !pattern.includes('/'))) };
	compiled.set(context, value);
	return value;
}

export function matchIgnorePattern(
	path: string,
	pattern: string,
	patternCache: Map<string, RegExp>
): boolean {
	if (pattern.endsWith('/')) {
		// Git internals also occur in nested repositories and worktree pointer files.
		return path.startsWith(pattern) || path === pattern.slice(0, -1)
			|| (pattern === '.git/' && (path.includes('/.git/') || path.endsWith('/.git')));
	}

	let regex = patternCache.get(pattern);
	if (!regex) {
		regex = compilePattern(pattern) ?? /^$/;
		patternCache.set(pattern, regex);
	}

	if (pattern.includes('/')) {
		return regex.test(path);
	}

	const basename = path.split('/').pop() ?? path;
	return regex.test(path) || regex.test(basename);
}

/** A hidden file or folder below a visible folder, like `notes/.cache/a.json`. Sync leaves
 * these out: finding them would mean listing every folder of the vault. Hidden folders at
 * the root, like `.obsidian`, sync with everything inside them. */
function isNestedHiddenPath(path: string): boolean {
	return !path.startsWith('.') && path.includes('/.');
}

export function shouldIgnoreSyncPath(
	path: string,
	context: IgnoreMatcherContext
): boolean {
	if (isConflictFile(path)) {
		return true;
	}

	return shouldIgnoreConfiguredPath(path, context);
}

export function shouldIgnoreConfiguredPath(
	path: string,
	context: IgnoreMatcherContext,
): boolean {
	// Recovery copies created by local trash must never re-enter sync.
	if (path === '.trash' || path.startsWith('.trash/')) return true;
	if (isNestedHiddenPath(path)) return true;
	for (const prefix of context.ignoredDirPrefixes) {
		if (matchIgnorePattern(path, prefix, context.patternCache)) {
			return true;
		}
	}

	const { withSlash, anyName } = compiledPatterns(context);
	if (withSlash?.test(path)) return true;
	if (!anyName) return false;
	return anyName.test(path) || anyName.test(path.slice(path.lastIndexOf('/') + 1));
}

export interface SyncIgnoreMatcher {
	/** Whether sync leaves a path out, including conflict copies. */
	readonly shouldIgnore: (path: string) => boolean;
	/** The configured-path check for the patterns current now. */
	readonly configuredMatcher: () => (path: string) => boolean;
	/** Rebuilds the matcher after a settings change. */
	readonly reset: () => void;
}

/** Matches paths against the current settings' patterns plus folders the host owns.
 * Settings writes can replace the pattern list in place before the engine hears of
 * them, so a replaced list also rebuilds the matcher. */
export function createSyncIgnoreMatcher(fixedPrefixes: () => string[], ignorePatterns: () => string[]): SyncIgnoreMatcher {
	const build = () => createIgnoreMatcherContext(fixedPrefixes(), ignorePatterns());
	let context = build();
	const current = () => {
		if (context.ignorePatterns !== ignorePatterns()) context = build();
		return context;
	};
	return {
		shouldIgnore: path => shouldIgnoreSyncPath(path, current()),
		configuredMatcher: () => {
			const snapshot = current();
			return path => shouldIgnoreConfiguredPath(path, snapshot);
		},
		reset: () => { context = build(); },
	};
}
