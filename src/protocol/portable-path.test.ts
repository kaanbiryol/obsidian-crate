import { describe, expect, it } from 'vitest';
import { assertPortablePaths, findPortablePathCollisions, getPortablePathIssue } from './portable-path';

describe('portable sync paths', () => {
	it('rejects Windows-reserved names and unsupported segment characters', () => {
		expect(getPortablePathIssue('notes/CON.md')).toContain('reserved name');
		expect(getPortablePathIssue('notes/question?.md')).toContain('not supported on Windows');
		expect(getPortablePathIssue('notes/trailing.')).toContain('ending in a dot or space');
		expect(getPortablePathIssue('notes/valid.md')).toBeNull();
	});

	it('detects case-insensitive and Unicode-normalizing collisions', () => {
		expect(findPortablePathCollisions(['Notes/A.md', 'notes/a.md'])).toHaveLength(1);
		expect(() => assertPortablePaths(['café.md', 'cafe\u0301.md'])).toThrow('Unicode-normalizing');
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
