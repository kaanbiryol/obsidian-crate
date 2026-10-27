import { describe, expect, it } from 'vitest';
import { isSyncPath } from './sync-validation';
import { assertPortablePaths, getPortablePathIssue } from './portable-path';

describe('portable sync paths', () => {
	it('rejects Windows-reserved names and unsupported segment characters', () => {
		expect(getPortablePathIssue('notes/CON.md')).toContain('reserved name');
		expect(getPortablePathIssue('notes/question?.md')).toContain('not supported on Windows');
		expect(getPortablePathIssue('notes/trailing.')).toContain('ending in a dot or space');
		expect(getPortablePathIssue('notes/valid.md')).toBeNull();
	});

	it('detects case-insensitive and Unicode-normalizing collisions', () => {
		expect(() => assertPortablePaths(['Notes/A.md', 'other.md', 'notes/a.md'])).toThrow('Unicode-normalizing device: Notes/A.md, notes/a.md');
		expect(() => assertPortablePaths(['café.md', 'cafe\u0301.md'])).toThrow('Unicode-normalizing');
	});

	it('accepts a repeated path and reports a collision before a file-versus-folder conflict', () => {
		expect(() => assertPortablePaths(['a.md', 'a.md', 'b/c.md'])).not.toThrow();
		expect(() => assertPortablePaths(['b', 'b/c.md', 'X.md', 'x.md'])).toThrow('Unicode-normalizing device: X.md, x.md');
		expect(() => assertPortablePaths(['Deep/A/b.md', 'deep/a', 'other.md'])).toThrow('File "deep/a" conflicts with the parent folder of "Deep/A/b.md"');
	});

	it.each([
		['Projects.md', 'Projects.md/child.md'],
		['projects.md/child.md', 'Projects.md'],
		['Café.md', 'cafe\u0301.md/child.md'],
	])('rejects file ancestors in either order: %j', (first, second) => {
		expect(() => assertPortablePaths([first, second])).toThrow('parent folder');
	});

	it('allows ordinary siblings and shared directories', () => {
		expect(() => assertPortablePaths(['Projects.md', 'Projects.md-copy', 'Projects/a.md', 'Projects/b.md'])).not.toThrow();
	});
});

it.each(['99 Utilities/assets/What Improves Developer Productivity at Google?.pdf', 'notes/CON.md', 'notes/trailing.'])('accepts native filenames in sync storage: %s', path => {
 expect(isSyncPath(path)).toBe(true);
 expect(() => assertPortablePaths([path])).not.toThrow();
});
it.each(['../escape.md', '/absolute.md', 'a//b.md', 'a\\b.md', 'a\u0000.md'])('still rejects unsafe paths: %s', path => {
 expect(isSyncPath(path)).toBe(false);
 expect(() => assertPortablePaths([path])).toThrow();
});
