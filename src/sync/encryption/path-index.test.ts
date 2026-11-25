import { expect, it, vi } from 'vitest';
import { PathTags } from '../../encryption/path-tags';
import { PathIndex, type WireStore } from './path-index';

const vaultId = '0b8e2f9c-4c7a-4d3e-9a51-2f6c1d8e7b40';
const secret = { id: 'b4d0c0de-0000-4000-8000-000000000001', secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' };
const tags = () => PathTags.fromSecret(vaultId, secret);

const store = (paths: string[], wires: Record<string, string> = {}): WireStore => ({
	getAllPaths: () => paths, wireOf: path => wires[path], noteWire: () => undefined,
});

it('derives a shared folder tag once for concurrent paths and matches a sequential walk', async () => {
	const parallel = await tags(), sequential = await tags();
	const tag = vi.spyOn(parallel, 'tag');
	const paths = Array.from({ length: 50 }, (_, index) => `Projects/Notes/${index}.md`);
	const wires = await Promise.all(paths.map(path => parallel.wire(path)));
	const expected: string[] = [];
	for (const path of paths) expected.push(await sequential.wire(path));
	expect(wires).toEqual(expected);
	// One tag per file plus one per folder.
	expect(tag).toHaveBeenCalledTimes(paths.length + 2);
});

it('rebuilds every synced server path once, even for concurrent lookups, and keeps the first claimant', async () => {
	const t = await tags();
	const index = new PathIndex(t);
	const paths = [...Array.from({ length: 100 }, (_, i) => `Folder ${i % 7}/Note ${i}.md`), 'Case.md', 'case.md', 'opaque.md'];
	index.useStore(store(paths, { 'opaque.md': 'random-server-name.md' }));
	const wire = vi.spyOn(t, 'wire');
	const [first, last, shared, opaque] = await Promise.all([
		index.plainFor(await t.wire('Folder 0/Note 0.md')),
		index.plainFor(await t.wire('Folder 1/Note 99.md')),
		index.plainFor(await t.wire('CASE.md')),
		index.plainFor('random-server-name.md'),
	]);
	expect([first, last, shared, opaque]).toEqual(['Folder 0/Note 0.md', 'Folder 1/Note 99.md', 'Case.md', 'opaque.md']);
	// Three lookup tags above, then one rebuild over every path without a stored server name.
	expect(wire).toHaveBeenCalledTimes(3 + paths.length - 1);
	expect(await index.plainFor('unknown.md')).toBeUndefined();
	expect(wire).toHaveBeenCalledTimes(3 + paths.length - 1);
});
