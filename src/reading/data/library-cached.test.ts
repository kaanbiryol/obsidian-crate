import { describe, expect, it, vi } from 'vitest';
import { ReadingLibrary, type ReadingFile, type ReadingVault } from './library';
import { ReadingMaintenance } from './maintenance';
import { createReadingNote } from '../core/notes';
import { readReadingFrontmatter } from '../core/frontmatter';
import { READING_DUPLICATE_ID_ISSUE } from '../core/inventory';

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const note = (index: number, title = `Article ${index}`) => createReadingNote({ id: id(index), url: `https://example.invalid/${index}`, title, savedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() });

/** Notes with Obsidian's frontmatter cache beside them. `index: false` leaves a note unindexed. */
function vault(initial: Record<string, string>, { index = true } = {}) {
	const contents = new Map(Object.entries(initial)), versions = new Map<string, number>(), properties = new Map<string, Record<string, unknown> | undefined>();
	const reads: string[] = [], writes: string[] = [];
	let walks = 0;
	const indexNote = (path: string) => properties.set(path, readReadingFrontmatter(contents.get(path)!)?.value ?? {});
	if (index) for (const path of contents.keys()) indexNote(path);
	const file = (path: string): ReadingFile => ({ path, size: contents.get(path)!.length, modifiedAt: 1, revision: `${path}:${versions.get(path) ?? 0}` });
	const write = (path: string, content: string) => { contents.set(path, content); versions.set(path, (versions.get(path) ?? 0) + 1); };
	const fake: ReadingVault = {
		files: () => { walks++; return [...contents.keys()].map(file); },
		file: path => contents.has(path) ? file(path) : null,
		cachedProperties: current => properties.get(current.path),
		read: async current => { reads.push(current.path); return contents.get(current.path)!; },
		process: async (current, update) => { writes.push(current.path); const next = update(contents.get(current.path)!); write(current.path, next); return next; },
		create: async (path, content) => { write(path, content); },
		occupied: path => contents.has(path),
	};
	return {
		fake, reads, writes, walks: () => walks, write, indexNote,
		remove: (path: string) => { contents.delete(path); properties.delete(path); },
		setProperties: (path: string, value: Record<string, unknown> | undefined) => properties.set(path, value),
	};
}
const library = (fake: ReadingVault, background?: ReadingMaintenance) => new ReadingLibrary(fake, 'Reading', new AbortController().signal, background);
const maintenance = (fake: ReadingVault, canAdopt: () => boolean = () => true) => new ReadingMaintenance(fake, 'Reading', new AbortController().signal, canAdopt);
const titles = (target: ReadingLibrary) => target.getSnapshot().items.map(item => item.title);

describe('Reading library from cached frontmatter', () => {
	it('lists notes without reading them', async () => {
		const h = vault({ 'Reading/A.md': note(1), 'Reading/B.md': note(2) });
		const target = library(h.fake);
		await target.refresh();
		expect(titles(target)).toEqual(['Article 2', 'Article 1']);
		// Before: every note was read at startup.
		expect(h.reads).toEqual([]);
	});

	it('reads only notes the cache has not indexed or that fail validation', async () => {
		const h = vault({ 'Reading/A.md': note(1), 'Reading/B.md': note(2), 'Reading/C.md': note(3) });
		h.setProperties('Reading/A.md', undefined);
		h.setProperties('Reading/B.md', { crate_reading_version: 1, title: '' });
		const target = library(h.fake);
		await target.refresh();
		expect(h.reads.sort()).toEqual(['Reading/A.md', 'Reading/B.md']);
		expect(titles(target)).toEqual(['Article 3', 'Article 2', 'Article 1']);
	});

	it('updates one card per change and keeps every other item unchanged', async () => {
		const h = vault({ 'Reading/A.md': note(1), 'Reading/B.md': note(2), 'Reading/C.md': note(3) });
		const target = library(h.fake);
		await target.refresh();
		const [c, b, a] = target.getSnapshot().items;
		const walks = h.walks();
		h.write('Reading/B.md', note(2, 'Renamed article'));
		await target.refreshPaths(['Reading/B.md']);
		expect(h.reads).toEqual(['Reading/B.md']);
		// Before: every change listed the whole folder again.
		expect(h.walks()).toBe(walks);
		const [nextC, nextB, nextA] = target.getSnapshot().items;
		expect(nextC).toBe(c); expect(nextA).toBe(a);
		expect(nextB).not.toBe(b); expect(nextB?.title).toBe('Renamed article');
	});

	it('removes a deleted note and reports a duplicate ID created by one note', async () => {
		const h = vault({ 'Reading/A.md': note(1), 'Reading/B.md': note(2) });
		const target = library(h.fake);
		await target.refresh();
		h.remove('Reading/B.md');
		await target.refreshPaths(['Reading/B.md']);
		expect(titles(target)).toEqual(['Article 1']);
		h.write('Reading/Copy.md', note(1, 'Copy'));
		await target.refreshPaths(['Reading/Copy.md']);
		expect(target.getSnapshot().items).toEqual([]);
		expect(target.getSnapshot().issues).toEqual([
			{ path: 'Reading/A.md', message: READING_DUPLICATE_ID_ISSUE }, { path: 'Reading/Copy.md', message: READING_DUPLICATE_ID_ISSUE },
		]);
	});

	it('takes re-indexed properties without reading, except for notes already read this session', async () => {
		const h = vault({ 'Reading/A.md': note(1), 'Reading/B.md': note(2) });
		const target = library(h.fake);
		await target.refresh();
		h.write('Reading/B.md', note(2, 'Read from the note'));
		await target.refreshPaths(['Reading/B.md']);
		h.reads.length = 0;
		// Obsidian re-indexes A, changed while it was closed, and reports B late with older properties.
		h.write('Reading/A.md', note(1, 'Changed while closed'));
		h.indexNote('Reading/A.md');
		await target.refreshProperties(['Reading/A.md', 'Reading/B.md']);
		expect(h.reads).toEqual([]);
		expect(titles(target)).toEqual(['Read from the note', 'Changed while closed']);
	});

	it('edits a note after reading only that note', async () => {
		const h = vault({ 'Reading/A.md': note(1), 'Reading/B.md': note(2) });
		const target = library(h.fake);
		await target.refresh();
		const walks = h.walks();
		const item = target.getSnapshot().items.find(entry => entry.title === 'Article 1')!;
		await target.update(item, { favorite: true });
		expect(new Set(h.reads)).toEqual(new Set(['Reading/A.md']));
		expect(h.walks()).toBe(walks);
		expect(target.getSnapshot().items.find(entry => entry.title === 'Article 1')?.favorite).toBe(true);
	});

	it('lists the folder again for a path that is not a note, such as a renamed folder', async () => {
		const h = vault({ 'Reading/Old/A.md': note(1) });
		const target = library(h.fake);
		await target.refresh();
		h.remove('Reading/Old/A.md');
		h.write('Reading/New/A.md', note(1));
		h.indexNote('Reading/New/A.md');
		const walks = h.walks();
		await target.refreshPaths(['Reading/Old', 'Reading/New']);
		expect(h.walks()).toBe(walks + 1);
		expect(target.getSnapshot().items.map(item => item.path)).toEqual(['Reading/New/A.md']);
	});

	it('is not built until a view uses it, and is released some time after the last view closes', async () => {
		vi.useFakeTimers();
		try {
			const h = vault({ 'Reading/A.md': note(1) });
			const target = library(h.fake);
			expect(target.active).toBe(false);
			expect(h.walks()).toBe(0);
			const release = target.retain();
			await vi.waitFor(() => expect(titles(target)).toEqual(['Article 1']));
			release();
			await vi.advanceTimersByTimeAsync(29_000);
			expect(target.active).toBe(true);
			// Reopening within the delay keeps the list.
			const again = target.retain();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(target.active).toBe(true);
			again();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(target.active).toBe(false);
			expect(target.getSnapshot()).toMatchObject({ items: [], loading: true });
		} finally { vi.useRealTimers(); }
	});
});

describe('Reading background work', () => {
	const clip = '---\nsource: https://example.invalid/clip\n---\nClipped text.';

	it('finds a clip from cached properties and reads and imports only that note', async () => {
		const h = vault({ 'Reading/A.md': note(1), 'Reading/Clip.md': clip });
		await maintenance(h.fake).start();
		expect(h.reads).toEqual(['Reading/Clip.md']);
		expect(h.writes).toEqual(['Reading/Clip.md']);
	});

	it('retries an import that waited for sync without reading other notes', async () => {
		const h = vault({ 'Reading/A.md': note(1), 'Reading/Clip.md': clip });
		let syncing = true;
		const work = maintenance(h.fake, () => !syncing), target = library(h.fake, work);
		await work.start();
		await target.refresh();
		expect(target.getSnapshot().issues).toEqual([{ path: 'Reading/Clip.md', message: 'Note is waiting for import after sync.' }]);
		expect(h.writes).toEqual([]);
		syncing = false;
		h.reads.length = 0;
		await work.retry();
		expect(h.reads).toEqual(['Reading/Clip.md']);
		expect(h.writes).toEqual(['Reading/Clip.md']);
		expect(work.issues.size).toBe(0);
	});

	it('reports a changed note the strict parser rejects instead of listing its card', async () => {
		const duplicateKey = note(2).replace('favorite: false', 'favorite: false\nfavorite: true');
		const h = vault({ 'Reading/A.md': note(1), 'Reading/B.md': note(2) });
		// Obsidian's parser accepts the duplicate key, so its cached properties stay usable.
		h.write('Reading/B.md', duplicateKey);
		const work = maintenance(h.fake), target = library(h.fake, work);
		await target.refresh();
		// Obsidian's lenient cache lists it until the note is checked.
		expect(titles(target)).toEqual(['Article 2', 'Article 1']);
		await work.changed(['Reading/B.md']);
		expect(titles(target)).toEqual(['Article 1']);
		expect(target.getSnapshot().issues).toEqual([{ path: 'Reading/B.md', message: expect.stringContaining('valid YAML') as string }]);
		expect(h.writes).toEqual([]);
	});

	it('removes a deleted highlight marker from the properties, so cached cards match the note', async () => {
		const marked = note(1).replace('<!-- crate:article:end -->', 'Read ==this passage==.\n<!-- crate:article:end -->');
		const h = vault({ 'Reading/A.md': marked });
		const work = maintenance(h.fake);
		await work.changed(['Reading/A.md']);
		const recorded = await h.fake.read(h.fake.file!('Reading/A.md')!);
		expect(readReadingFrontmatter(recorded)!.value.highlights).toHaveLength(1);
		h.write('Reading/A.md', recorded.replace('==this passage==', 'this passage'));
		await work.changed(['Reading/A.md']);
		const edited = await h.fake.read(h.fake.file!('Reading/A.md')!);
		expect(readReadingFrontmatter(edited)!.value.highlights).toEqual([]);
		// Checking an unchanged note again writes nothing.
		const writes = h.writes.length;
		await work.changed(['Reading/A.md']);
		expect(h.writes).toHaveLength(writes);
	});
});
