import { isConflictFile } from './conflict';
import { createLogger, errorMessage } from '../plugin/logger';

const logger = createLogger('SyncEngine');

export interface IgnoreMatcherContext {
	pluginIgnorePaths: Set<string>;
	ignoredDirPrefixes: string[];
	ignorePatterns: string[];
	patternCache: Map<string, RegExp>;
}

export function matchIgnorePattern(
	path: string,
	pattern: string,
	patternCache: Map<string, RegExp>
): boolean {
	if (pattern.endsWith('/')) {
		return path.startsWith(pattern) || path === pattern.slice(0, -1);
	}

	let regex = patternCache.get(pattern);
	if (!regex) {
		const regexPattern = Array.from(pattern).map(char => {
			if (char === '*') return '.*';
			if (char === '?') return '.';
			return char.replace(/[\\^$+.|(){}[\]]/g, '\\$&');
		}).join('');
		try {
			regex = new RegExp(`^${regexPattern}$`);
		} catch (error) {
			logger.warn(`Invalid ignore pattern "${pattern}":`, errorMessage(error));
			regex = /^$/;
		}
		patternCache.set(pattern, regex);
	}

	if (pattern.includes('/')) {
		return regex.test(path);
	}

	const basename = path.split('/').pop() ?? path;
	return regex.test(path) || regex.test(basename);
}

export function shouldIgnoreSyncPath(
	path: string,
	context: IgnoreMatcherContext
): boolean {
	if (context.pluginIgnorePaths.has(path)) {
		return true;
	}

	if (isConflictFile(path)) {
		return true;
	}

	for (const prefix of context.ignoredDirPrefixes) {
		if (path.startsWith(prefix) || path === prefix.slice(0, -1)) {
			return true;
		}
	}

	for (const pattern of context.ignorePatterns) {
		if (pattern.endsWith('/')) continue;
		if (matchIgnorePattern(path, pattern, context.patternCache)) {
			return true;
		}
	}

	return false;
}
