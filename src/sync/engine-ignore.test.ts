import { describe, expect, it } from 'vitest';
import { normalizeCrateSettings } from '../plugin/settings';
import {
	matchIgnorePattern,
	shouldIgnoreConfiguredPath,
	shouldIgnoreSyncPath,
} from './engine-ignore';

function createIgnoreContext(ignorePatterns: string[] = []) {
	return {
		ignoredDirPrefixes: [
			'.vault-config/plugins/crate/',
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

	it.each(['.git', '.git/config', 'Projects/example/.git', 'Projects/example/.git/objects/pack/index'])(
		'matches Git internals at any depth in exclusion previews: %s', path => {
			expect(matchIgnorePattern(path, '.git/', new Map())).toBe(true);
		},
	);

	it('keeps other directory patterns relative to the vault root', () => {
		const patternCache = new Map<string, RegExp>();
		expect(matchIgnorePattern('Archive/note.md', 'Archive/', patternCache)).toBe(true);
		expect(matchIgnorePattern('Projects/Archive/note.md', 'Archive/', patternCache)).toBe(false);
		expect(matchIgnorePattern('Archive-old/note.md', 'Archive/', patternCache)).toBe(false);
	});

	it('treats regex metacharacters as literal text in patterns', () => {
		const patternCache = new Map<string, RegExp>();

		expect(matchIgnorePattern('notes[2026].md', 'notes[2026].md', patternCache)).toBe(true);
		expect(matchIgnorePattern('notes2.md', 'notes[2026].md', patternCache)).toBe(false);
		expect(matchIgnorePattern('[', '[', patternCache)).toBe(true);
	});
});

describe('shouldIgnoreSyncPath', () => {
	it.each(['.git', '.git/config', 'Projects/example/.git', 'Projects/example/.git/objects/pack/index'])(
		'excludes Git internals at any depth from sync: %s', path => {
			const context = createIgnoreContext(['.git/']);
			expect(shouldIgnoreSyncPath(path, context)).toBe(true);
			expect(shouldIgnoreConfiguredPath(path, context)).toBe(true);
		},
	);

	it.each(['._note.md', 'Thumbs.db', 'desktop.ini', '.note.md.swp', '.note.md.swo'])(
		'excludes OS metadata and editor swap files by default: %s', basename => {
			const settings = normalizeCrateSettings(undefined, '.obsidian');
			const context = createIgnoreContext(settings.ignorePatterns);
			expect(shouldIgnoreSyncPath(basename, context)).toBe(true);
			expect(shouldIgnoreSyncPath(`notes/attachments/${basename}`, context)).toBe(true);
		},
	);

	it('keeps Git configuration, ordinary dotfiles and backups eligible for sync', () => {
		const settings = normalizeCrateSettings(undefined, '.obsidian');
		const context = createIgnoreContext(settings.ignorePatterns);
		for (const path of ['.gitignore', '.gitattributes', '.gitmodules', '.github/workflows/ci.yml',
			'.git-backup/config', '.config/settings.json', 'note.md.bak', 'package-lock.json']) {
			expect(shouldIgnoreSyncPath(path, context), path).toBe(false);
			expect(shouldIgnoreSyncPath(`Projects/example/${path}`, context), path).toBe(false);
		}
	});

	it('respects removal of the Git exclusion and keeps custom folder exclusions at the root', () => {
		const context = createIgnoreContext(['Archive/']);
		expect(shouldIgnoreSyncPath('Archive/note.md', context)).toBe(true);
		expect(shouldIgnoreSyncPath('Projects/Archive/note.md', context)).toBe(false);
		expect(shouldIgnoreSyncPath('Projects/example/.git/config', context)).toBe(false);
		expect(shouldIgnoreSyncPath('Projects/.vault-config/plugins/crate/data.json', context)).toBe(false);
	});

	it('keeps local trash excluded even without user ignore patterns', () => {
		const context = createIgnoreContext();
		expect(shouldIgnoreSyncPath('.trash/settings.json', context)).toBe(true);
		expect(shouldIgnoreConfiguredPath('.trash', context)).toBe(true);
		expect(shouldIgnoreSyncPath('.trash-notes.md', context)).toBe(false);
	});
	it('keeps Crate local while allowing other plugins', () => {
		const context = createIgnoreContext();

		expect(shouldIgnoreSyncPath('.vault-config/plugins/crate/data.json', context)).toBe(true);
		expect(shouldIgnoreSyncPath('.vault-config/plugins/crate/file-manifest.json', context)).toBe(true);
		expect(shouldIgnoreSyncPath('.vault-config/plugins/crate/main.js', context)).toBe(true);
		for (const file of ['main.js', 'manifest.json', 'styles.css', 'data.json']) {
			expect(shouldIgnoreSyncPath(`.vault-config/plugins/other-plugin/${file}`, context)).toBe(false);
		}
	});

	it('ignores conflict files and configured filename patterns', () => {
		const context = createIgnoreContext(['.trash/', '*.tmp', '.DS_Store']);

		expect(shouldIgnoreSyncPath('notes/a (conflict 2026-01-02 03-04-05 a1b2).md', context)).toBe(true);
		expect(shouldIgnoreSyncPath('notes/file.tmp', context)).toBe(true);
		expect(shouldIgnoreSyncPath('notes/.DS_Store', context)).toBe(true);
		expect(shouldIgnoreSyncPath('notes/file.md', context)).toBe(false);
	});

	it('lets conflict recovery apply configured rules without blanket-ignoring conflict names', () => {
		const context = createIgnoreContext(['.trash/', '*.tmp']);

		expect(shouldIgnoreConfiguredPath('.trash/a (conflict 2026-01-02 03-04-05 a1b2).md', context)).toBe(true);
		expect(shouldIgnoreConfiguredPath('notes/a (conflict 2026-01-02 03-04-05 a1b2).md', context)).toBe(false);
	});
});
