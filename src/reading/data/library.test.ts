import { describe, expect, it, vi } from 'vitest';
import { ReadingLibrary, type ReadingFile, type ReadingVault } from './library';
import { createReadingNote, parseReadingNote, updateReadingNote } from '../core/notes';

function harness() {
	const files = new Map<string, string>();
	const controller = new AbortController();
	let canAdopt = true;
	const process = vi.fn(async (file: ReadingFile, update: (content: string) => string) => {
		const current = files.get(file.path);
		if (current === undefined) throw new Error('Deleted');
		const result = update(current); files.set(file.path, result); return result;
	});
	const vault: ReadingVault = { files: () => [...files].map(([path, content]) => ({ path, size: new TextEncoder().encode(content).length })),
		read: async file => files.get(file.path)!, process, create: async (path, content) => { if (files.has(path)) throw new Error('Already exists'); files.set(path, content); } };
	const library = new ReadingLibrary(vault, 'Reading', controller.signal, () => canAdopt);
	return { library, vault, files, process, controller, defer: () => { canAdopt = false; }, resume: () => { canAdopt = true; } };
}
const clip = '---\ncrate_reading_import: web-clipper-v1\ntitle: A clip\nsource_url: https://example.com\nsaved_at: 2026-09-21T12:00:00Z\n---\n\nExact clipped text.\n';

describe('local Reading library', () => {
	it('caches unchanged metadata and invalidates it for vault events', async () => {
		const h = harness(); const { item } = await h.library.add('https://example.com');
		const files = h.vault.files.bind(h.vault);
		h.vault.files = () => files().map(file => ({ ...file, revision: 'same-filesystem-timestamp' }));
		const reads = vi.spyOn(h.vault, 'read');
		await h.library.refresh(); await h.library.refresh(); expect(reads).toHaveBeenCalledTimes(1);
		h.files.set(item.path, updateReadingNote(h.files.get(item.path)!, item.crate_reading_id, { favorite: true }));
		h.library.invalidate(item.path); await h.library.refresh();
		expect(reads).toHaveBeenCalledTimes(2); expect(h.library.getSnapshot().items[0]?.favorite).toBe(true);
		h.files.delete(item.path); await h.library.refresh(); expect(h.library.getSnapshot().items).toEqual([]);
	});
	it('defers adoption during sync and only writes explicitly marked files', async () => {
		const h = harness(); h.files.set('Reading/Clip.md', clip); h.files.set('Reading/Private.md', '# Personal notes');
		h.defer(); await h.library.refresh(); expect(h.process).not.toHaveBeenCalled();
		expect(h.library.getSnapshot().issues).toHaveLength(1);
		h.resume(); await h.library.refresh();
		expect(h.process).toHaveBeenCalledTimes(1); expect(h.library.getSnapshot().items).toHaveLength(1);
		expect(h.files.get('Reading/Private.md')).toBe('# Personal notes');
		await h.library.refresh(); expect(h.process).toHaveBeenCalledTimes(1);
	});
	it('does not overwrite an edit arriving during adoption', async () => {
		const h = harness(); h.files.set('Reading/Clip.md', clip);
		h.process.mockImplementationOnce(async (file, update) => {
			h.files.set(file.path, clip + 'My new notes.');
			return update(h.files.get(file.path)!);
		});
		await h.library.refresh();
		expect(h.files.get('Reading/Clip.md')).toBe(clip + 'My new notes.');
		expect(h.library.getSnapshot().issues[0]?.message).toContain('changed');
		await h.library.refresh(); expect(h.library.getSnapshot().items).toHaveLength(1);
	});
	it('serializes repeated local captures and keeps archive and date on duplicate saves', async () => {
		const h = harness();
		const [first, second] = await Promise.all([h.library.add('https://example.com#one', 'First'), h.library.add('https://example.com#two', 'Second')]);
		expect(second.duplicate).toBe(true); expect(second.item.crate_reading_id).toBe(first.item.crate_reading_id);
		await h.library.update(first.item, { reading_status: 'archived' });
		const repeated = await h.library.add('https://example.com');
		expect(repeated.item).toMatchObject({ reading_status: 'archived', title: 'First', saved_at: first.item.saved_at });
		expect(h.files.size).toBe(1);
	});
	it('preserves concurrent body edits but rejects a stale metadata change', async () => {
		const h = harness(); const { item } = await h.library.add('https://example.com');
		h.files.set(item.path, h.files.get(item.path)! + '\nMy notes.');
		await h.library.update(item, { favorite: true });
		expect(h.files.get(item.path)).toContain('\nMy notes.');
		await expect(h.library.update(item, { favorite: true })).rejects.toThrow('changed elsewhere');
	});
	it('reports duplicate identities and never chooses an arbitrary source', async () => {
		const h = harness(); const { item } = await h.library.add('https://example.com');
		h.files.set('Reading/Copy.md', h.files.get(item.path)!);
		await h.library.refresh(); expect(h.library.getSnapshot().items).toHaveLength(0); expect(h.library.getSnapshot().issues).toHaveLength(2);
		await expect(h.library.update(item, { favorite: true })).rejects.toThrow('identity conflict');
	});
	it('does not resurrect a deleted or replaced source during an update', async () => {
		const h = harness(); const { item } = await h.library.add('https://example.com');
		h.process.mockImplementationOnce(async (file, update) => {
			const replacement = createReadingNote({ id: crypto.randomUUID(), url: 'https://another.example.com', savedAt: item.saved_at });
			h.files.set(file.path, replacement); return update(replacement);
		});
		await expect(h.library.update(item, { favorite: true })).rejects.toThrow('changed');
		expect(parseReadingNote(h.files.get(item.path)!)?.source_url).toBe('https://another.example.com/');
		h.files.delete(item.path);
		await expect(h.library.update(item, { favorite: true })).rejects.toThrow(); expect(h.files.size).toBe(0);
	});
	it('cancels queued writes when the runtime is stopped', async () => {
		const h = harness(); const pending = h.library.add('https://example.com'); h.controller.abort();
		await expect(pending).rejects.toThrow(); expect(h.files.size).toBe(0);
	});
	it('merges independent properties without losing the latest value', async () => {
		const h = harness(); const { item } = await h.library.add('https://example.com');
		h.files.set(item.path, updateReadingNote(h.files.get(item.path)!, item.crate_reading_id, { tags: ['latest'] }));
		await h.library.update(item, { favorite: true });
		expect(parseReadingNote(h.files.get(item.path)!)).toMatchObject({ tags: ['latest'], favorite: true });
	});
});
