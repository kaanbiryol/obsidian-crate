import { expect, it } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import { LocalManifest } from './manifest';

const entry = { hash: 'a'.repeat(64), size: 1, modified: new Date(0).toISOString(), revision: 'r1' };

function diskApp() {
	const disk = new Map<string, string>();
	const adapter = {
		exists: async (path: string) => disk.has(path),
		read: async (path: string) => disk.get(path)!,
		write: async (path: string, data: string) => { disk.set(path, data); },
		append: async (path: string, data: string) => { disk.set(path, (disk.get(path) ?? '') + data); },
		remove: async (path: string) => { disk.delete(path); },
		list: async () => ({ files: [...disk.keys()], folders: [] }),
	};
	return { vault: { adapter, configDir: '.vault-config' } } as unknown as App;
}
function manifestFor(app: App = diskApp()) {
	return new LocalManifest(app, { dir: '.vault-config/plugins/crate' } as PluginManifest, 'https://server.example');
}

/** The previous implementation, scanning every dependency on each event. */
function referenceRename(deps: Map<string, string>, tracked: ReadonlySet<string>, source: string, destination: string) {
	const move = (path: string) => path === source ? destination : path.startsWith(`${source}/`) ? destination + path.slice(source.length) : path;
	for (const [old, target] of deps) {
		const next = move(target);
		if (old === next) deps.delete(old);
		else deps.set(old, next);
	}
	for (const path of tracked.has(source) ? [source] : [...tracked]) {
		const target = move(path);
		if (target !== path && !deps.has(path)) deps.set(path, target);
	}
}

it('records the same dependencies as a full scan for file and folder moves, chains and moves back', () => {
	let seed = 7;
	const random = (limit: number) => { seed = (seed * 48271) % 2147483647; return seed % limit; };
	for (let round = 0; round < 200; round++) {
		const manifest = manifestFor();
		const tracked = new Set<string>();
		for (const folder of ['A', 'B', 'C']) for (let i = 0; i < 4; i++) {
			tracked.add(`${folder}/n${i}.md`);
			manifest.setEntry(`${folder}/n${i}.md`, entry);
		}
		const reference = new Map<string, string>();
		// Current location of each file, so events describe moves Obsidian could report.
		const current = new Map([...tracked].map(path => [path, path]));
		for (let step = 0; step < 12; step++) {
			const folders = ['A', 'B', 'C', 'D', 'E'];
			if (random(3) === 0) {
				const from = folders[random(5)]!, to = folders[random(5)]!;
				const moved = [...current].filter(([, path]) => path.startsWith(`${from}/`));
				if (from === to || !moved.length || [...current.values()].some(path => path.startsWith(`${to}/`))) continue;
				// A folder event followed by one event per file, in either order.
				const events: Array<[string, string, 'file' | 'folder']> = [[from, to, 'folder'],
					...moved.map(([, path]): [string, string, 'file'] => [path, to + path.slice(from.length), 'file'])];
				if (random(2)) events.reverse();
				for (const [source, destination, kind] of events) {
					manifest.recordRename(source, destination, kind);
					referenceRename(reference, tracked, source, destination);
				}
				for (const [origin, path] of moved) current.set(origin, to + path.slice(from.length));
			} else {
				const [origin, path] = [...current][random(current.size)]!;
				const destination = `${folders[random(5)]}/r${step}-${random(9)}.md`;
				if ([...current.values()].includes(destination)) continue;
				manifest.recordRename(path, destination, 'file');
				referenceRename(reference, tracked, path, destination);
				current.set(origin, destination);
			}
			expect(manifest.getRenameDependencies()).toEqual(Object.fromEntries(reference));
		}
	}
});

it('moves a 20,000-file folder without rescanning every dependency per file', () => {
	const manifest = manifestFor();
	const count = 20_000;
	for (let i = 0; i < count; i++) manifest.setEntry(`Old/n${i}.md`, entry);
	const started = performance.now();
	manifest.recordRename('Old', 'New', 'folder');
	for (let i = 0; i < count; i++) manifest.recordRename(`Old/n${i}.md`, `New/n${i}.md`, 'file');
	// Before: about 21 seconds on an M-series Mac, growing with the square of the file count.
	expect(performance.now() - started).toBeLessThan(1_000);
	expect(Object.keys(manifest.getRenameDependencies())).toHaveLength(count);
	expect(manifest.renameDestination('Old/n19999.md')).toBe('New/n19999.md');
});

it('keeps following saved dependencies after a restart', async () => {
	const app = diskApp();
	const manifest = manifestFor(app);
	manifest.setEntry('A/note.md', entry);
	manifest.recordRename('A/note.md', 'B/note.md', 'file');
	await manifest.save();

	const restarted = manifestFor(app);
	await restarted.load();
	restarted.recordRename('B/note.md', 'C/note.md', 'file');
	expect(restarted.getRenameDependencies()).toEqual({ 'A/note.md': 'C/note.md' });
	restarted.recordRename('C/note.md', 'A/note.md', 'file');
	expect(restarted.getRenameDependencies()).toEqual({});
});
