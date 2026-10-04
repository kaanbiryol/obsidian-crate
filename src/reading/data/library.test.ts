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
	const vault: ReadingVault = { files: () => [...files].map(([path, content]) => ({ path, modifiedAt: Date.parse('2026-09-21T12:00:00Z'), size: new TextEncoder().encode(content).length })),
		read: async file => files.get(file.path)!, process, create: async (path, content) => { if (files.has(path)) throw new Error('Already exists'); files.set(path, content); } };
	const library = new ReadingLibrary(vault, 'Reading', controller.signal, () => canAdopt);
	return { library, vault, files, process, controller, defer: () => { canAdopt = false; }, resume: () => { canAdopt = true; } };
}
const clip = '---\ncrate_reading_import: web-clipper-v1\ntitle: A clip\nsource_url: https://example.com\nsaved_at: 2026-09-21T12:00:00Z\n---\n\nExact clipped text.\n';

describe('local Reading library', () => {
	it('keeps queued captures outside the vault until their final note syncs', async () => {
		const h = harness();
		const note = createReadingNote({ id: 'a1b2c3d4-5678-4abc-9def-123456789abc', url: 'https://example.com/article', savedAt: '2026-09-28T00:00:00Z' });
		const item = { ...parseReadingNote(note)!, path: '' };
		const queueCapture = vi.fn(async () => item);
		h.vault.queueCapture = queueCapture;
		h.vault.pendingCaptures = async () => queueCapture.mock.calls.length ? [item] : [];
		expect((await h.library.add(item.source_url)).item).toEqual(item);
		expect(h.files.size).toBe(0);
		expect((await h.library.add(item.source_url)).duplicate).toBe(true);
		await expect(h.library.update(item, { favorite: true })).rejects.toThrow('still being saved');
		h.files.set('Reading/Actual title - a1b2c3d4.md', note.replace('title: "example.com"', 'title: "Actual title"').replace('"pending"', '"ready"'));
		await h.library.refresh();
		expect(h.library.getSnapshot().items).toHaveLength(1);
		expect(h.library.getSnapshot().items[0]).toMatchObject({ path: 'Reading/Actual title - a1b2c3d4.md', title: 'Actual title', crate_reading_id: item.crate_reading_id });
	});

	it('keeps vault notes readable when pending capture storage needs recovery', async () => {
		const h = harness();
		h.files.set('Reading/Note.md', 'Personal note.');
		h.vault.pendingCaptures = async () => { throw new Error('Pending saves need recovery'); };
		await h.library.refresh();
		expect(h.library.getSnapshot().items).toHaveLength(1);
		expect(h.library.getSnapshot().issues).toEqual([{ path: 'Reading', message: 'Pending saves need recovery' }]);
	});
	it('saves local-only bookmarks when no capture queue is configured', async () => {
		const { library } = harness();
		expect((await library.add('https://example.com/bookmark', undefined, false)).item.extraction_status).toBe('unavailable');
		expect((await library.add('https://example.com/article')).item.extraction_status).toBe('unavailable');
	});

	it('imports default clips and source-less notes together, preserving edits and duplicate captures', async () => {
		const h = harness();
		const ordinaryClip = '---\nsource: https://example.com/article\ntags: [clippings]\n---\n\nClipped text.';
		h.files.set('Reading/Nested/Article.md', ordinaryClip);
		h.files.set('Reading/Second.md', ordinaryClip);
		h.files.set('Reading/Notes.md', 'Personal thoughts.');
		await h.library.refresh(); expect(h.library.getSnapshot().items).toHaveLength(3);
		const item = h.library.getSnapshot().items.find(item => item.title === 'Notes')!;
		await h.library.update(item, { reading_status: 'archived', favorite: true });
		expect((await h.library.read(item)).markdown).toBe('Personal thoughts.');
		await expect(h.library.add('https://example.com/article')).rejects.toThrow('Multiple notes');
		expect((await h.library.add('https://another.example.com')).duplicate).toBe(false);
	});
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
	it('defers adoption during sync and imports every Markdown note only within the reading folder', async () => {
		const h = harness(); h.files.set('Reading/Clip.md', clip); h.files.set('Reading/Personal.md', '# Personal notes'); h.files.set('Outside/Private.md', '# Private'); h.files.set('Reading/image.png', 'image'); h.files.set('ReadingElsewhere/Private.md', '# Private');
		h.defer(); await h.library.refresh(); expect(h.process).not.toHaveBeenCalled();
		expect(h.library.getSnapshot().issues).toHaveLength(2);
		h.resume(); await h.library.refresh();
		expect(h.process).toHaveBeenCalledTimes(2); expect(h.library.getSnapshot().items).toHaveLength(2);
		expect(h.files.get('Outside/Private.md')).toBe('# Private'); expect(h.files.get('Reading/image.png')).toBe('image'); expect(h.files.get('ReadingElsewhere/Private.md')).toBe('# Private');
		expect(h.files.get('Reading/Personal.md')).toMatch(/---\n# Personal notes$/);
		await h.library.refresh(); expect(h.process).toHaveBeenCalledTimes(2);
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


describe('local article downloads', () => {
  const article = { markdown: 'Article text saved on this device.', title: 'An article', author: 'Writer' };
  it('saves before downloading, skips server capture and preserves metadata and personal notes', async () => {
    const h = harness(), pending = deferred<typeof article>();
    h.vault.captureArticle = vi.fn(() => pending.promise);
    const queueCapture = vi.fn(); h.vault.queueCapture = queueCapture;
    const { item } = await h.library.add('https://example.com/article');
    expect(h.files.has(item.path)).toBe(true);
    expect(parseReadingNote(h.files.get(item.path)!)?.extraction_status).toBe('unavailable');
    expect(queueCapture).not.toHaveBeenCalled();
    expect(h.library.isCapturing(item)).toBe(true);
    const finished = h.library.retryCapture(item);
    await h.library.update(item, { favorite: true });
    h.files.set(item.path, h.files.get(item.path)! + '\nPersonal notes.');
    expect((await h.library.add(item.source_url)).duplicate).toBe(true);
    pending.resolve(article); await finished;
    expect(h.vault.captureArticle).toHaveBeenCalledTimes(1);
    expect(parseReadingNote(h.files.get(item.path)!)).toMatchObject({ title: 'An article', author: 'Writer', favorite: true, extraction_status: 'ready' });
    expect(h.files.get(item.path)).toContain('Article text saved on this device.');
    expect(h.files.get(item.path)).toContain('Personal notes.');
    expect(h.library.isCapturing(item)).toBe(false);
  });
  it('keeps failed/offline bookmarks and allows retry after restarting the library', async () => {
    const h = harness(); h.vault.captureArticle = vi.fn().mockRejectedValue(new Error('Offline'));
    const { item } = await h.library.add('https://example.com/article');
    await expect(h.library.retryCapture(item)).rejects.toThrow('Offline');
    await h.library.refresh();
    expect(h.library.getSnapshot().issues[0]?.message).toContain('Link saved. Offline');
    expect(h.files.size).toBe(1);
    const resumed = new ReadingLibrary(h.vault, 'Reading', h.controller.signal);
    h.vault.captureArticle = vi.fn().mockResolvedValue(article);
    await resumed.retryCapture(item);
    expect(parseReadingNote(h.files.get(item.path)!)?.extraction_status).toBe('ready');
  });
  it.each(['edited', 'deleted', 'replaced', 'duplicate', 'stopped'])('does not overwrite a %s note after a download', async state => {
    const h = harness(), pending = deferred<typeof article>();
    h.vault.captureArticle = vi.fn(() => pending.promise);
    const { item } = await h.library.add('https://example.com/article');
    const finished = h.library.retryCapture(item);
    await vi.waitFor(() => expect(h.vault.captureArticle).toHaveBeenCalled());
    if (state === 'edited') h.files.set(item.path, h.files.get(item.path)!.replace('<!-- crate:article:end -->', 'My own text.\n<!-- crate:article:end -->'));
    if (state === 'deleted') h.files.delete(item.path);
    if (state === 'replaced') h.files.set(item.path, createReadingNote({ id: crypto.randomUUID(), url: 'https://other.example.com', savedAt: item.saved_at }));
    if (state === 'duplicate') h.files.set('Reading/Copy.md', h.files.get(item.path)!);
    if (state === 'stopped') h.controller.abort();
    const before = [...h.files];
    pending.resolve(article);
    await expect(finished).rejects.toThrow();
    expect([...h.files]).toEqual(before);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

it('reuses a clipped video for equivalent URL saves and safely enriches a bookmark clipped later', async () => {
  const h = harness();
  h.files.set('Reading/Clipped video.md', '---\ntitle: Clipped video\nsource: https://www.youtube.com/watch?v=jNQXAC9IVRw\n---\n**0:42** · A useful passage.\n');
  const first = await h.library.add('https://youtu.be/jNQXAC9IVRw?t=99', undefined, false);
  expect(first.duplicate).toBe(true);
  expect(h.files.size).toBe(1);
  const other = harness();
  const bookmark = (await other.library.add('https://youtu.be/jNQXAC9IVRw', undefined, false)).item;
  other.files.set('Reading/Clipped video.md', h.files.get('Reading/Clipped video.md')!);
  await other.library.refresh();
  const clip = other.library.getSnapshot().items.find(item => item.capture_method === 'web-clipper')!;
  await other.library.enrich(bookmark, clip);
  expect(other.files.size).toBe(2);
  expect((await other.library.read(bookmark)).markdown).toContain('**0:42**');
  await expect(other.library.enrich(bookmark, clip)).rejects.toThrow('empty bookmark');
});
