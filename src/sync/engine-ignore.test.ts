import { describe, expect, it } from 'vitest';
import { matchIgnorePattern, shouldIgnoreSyncPath } from './engine-ignore';

function createIgnoreContext(ignorePatterns: string[] = []) {
	return {
		ignoredDirPrefixes: [
			'.vault-config/plugins/',
			...ignorePatterns.filter(pattern => pattern.endsWith('/')),
		],
		ignorePatterns,
		patternCache: new Map<string, RegExp>(),
	};
}

describe('matchIgnorePattern', () => {
	it('matches trailing-slash patterns and wildcard patterns', () => {
		const patternCache = new Map<string, RegExp>();

		expect(matchIgnorePattern('.trash', '.trash/', patternCache)).toBe(true);
		expect(matchIgnorePattern('.trash/file.md', '.trash/', patternCache)).toBe(true);
		expect(matchIgnorePattern('notes/file.tmp', '*.tmp', patternCache)).toBe(true);
		expect(matchIgnorePattern('notes/file.md', '*.tmp', patternCache)).toBe(false);
	});

	it('matches slashless filename patterns against nested files', () => {
		const patternCache = new Map<string, RegExp>();

		expect(matchIgnorePattern('.DS_Store', '.DS_Store', patternCache)).toBe(true);
		expect(matchIgnorePattern('notes/.DS_Store', '.DS_Store', patternCache)).toBe(true);
	});

	it('treats regex metacharacters as literal text in patterns', () => {
		const patternCache = new Map<string, RegExp>();

		expect(matchIgnorePattern('notes[2026].md', 'notes[2026].md', patternCache)).toBe(true);
		expect(matchIgnorePattern('notes2.md', 'notes[2026].md', patternCache)).toBe(false);
		expect(matchIgnorePattern('[', '[', patternCache)).toBe(true);
	});
});

describe('shouldIgnoreSyncPath', () => {
	it('always ignores executable plugin directories', () => {
		const context = createIgnoreContext();

		expect(shouldIgnoreSyncPath('.vault-config/plugins/crate/data.json', context)).toBe(true);
		expect(shouldIgnoreSyncPath('.vault-config/plugins/crate/file-manifest.json', context)).toBe(true);
		expect(shouldIgnoreSyncPath('.vault-config/plugins/crate/main.js', context)).toBe(true);
		expect(shouldIgnoreSyncPath('.vault-config/plugins/other-plugin/manifest.json', context)).toBe(true);
	});

	it('ignores conflict files and configured filename patterns', () => {
		const context = createIgnoreContext(['.trash/', '*.tmp', '.DS_Store']);

		expect(shouldIgnoreSyncPath('notes/a (conflict 2026-01-02 03-04-05 a1b2).md', context)).toBe(true);
		expect(shouldIgnoreSyncPath('notes/file.tmp', context)).toBe(true);
		expect(shouldIgnoreSyncPath('notes/.DS_Store', context)).toBe(true);
		expect(shouldIgnoreSyncPath('notes/file.md', context)).toBe(false);
	});
});
