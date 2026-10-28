import { expect, it } from 'vitest';
import { namespaceConflictLookup } from './namespace-conflicts';

it.each([
	['TODO.md', 'todo.md'],
	['notes/Caf\u00e9.md', 'Notes/cafe\u0301.md'],
	['Projects', 'projects/plan.md'],
	['projects/plan.md', 'Projects'],
	['a/b/c.md', 'A/B'],
])('finds the indexed path the server cannot store beside %j: %j', (path, indexed) => {
	expect(namespaceConflictLookup(['other.md', indexed])(path)).toBe(indexed);
});

it.each([
	['todo.md', 'todo.md'],
	['Projects.md', 'Projects.md-copy'],
	['notes/a.md', 'Notes/b.md'],
	['projects-2/plan.md', 'projects'],
])('allows %j beside %j', (path, indexed) => {
	expect(namespaceConflictLookup([indexed])(path)).toBeUndefined();
});
