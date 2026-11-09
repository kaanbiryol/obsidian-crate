import { beforeAll, expect, it, vi } from 'vitest';
import { generateEncryptionSecret, importEncryptionSecret } from '@/encryption/envelope';
import { openFile, sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import type { EncryptedInventoryFile } from '@/encryption/file-inventory';
import { EncryptedReadingApi, type EncryptedReadingIndexEntry } from './encrypted-api';
import { createReadingNote, parseReadingNote } from '../../reading/core/notes';
import { READING_DUPLICATE_ID_ISSUE } from '../../reading/core/inventory';
import { managedArticle } from '../../reading/core/article';
import { readingFileCommandRefusal } from '../../reading/core/reading-file-command';
import { captureServerArticle } from './capture-article';
import { PathTags } from '@/encryption/path-tags';

let authority: FileEncryptionAuthority;
// The server lists notes by tagged paths inside the tagged Reading folder.
let paths: PathTags, wireFolder: string;
beforeAll(async () => {
	authority = { vaultId: 'vault-a', scopeId: 'reading-a', key: await importEncryptionSecret(generateEncryptionSecret()) };
	paths = await PathTags.fromSecret('vault-a', generateEncryptionSecret());
	wireFolder = await paths.wire('Reading');
});
const page = (files: EncryptedInventoryFile[] = [], nextCursor: string | null = null, sequence = 1) => ({ files, nextCursor, sequence, generation: 1 });
const itemId = '00000000-0000-4000-8000-000000000001';
function harness() {
	const request = vi.fn<(path: string) => Promise<Response>>(async () => { throw new Error('Unexpected request'); });
	const api = new EncryptedReadingApi({ folderPath: 'Reading', wireFolder, paths, generation: 1, authority, request,
		readAttempt: async () => undefined, writeAttempt: async () => {}, error: message => new Error(message) });
	return { api, request };
}
async function article(title: string) {
	const path = 'Reading/Article.md';
	const text = createReadingNote({ id: itemId, url: 'https://example.com/article', title, savedAt: '2026-10-01T12:00:00Z' }) + `\n${title} text.\n`;
	const sealed = await sealFile({ path, content: new TextEncoder().encode(text), contentType: 'text/markdown', publicData: null }, authority);
	return { bytes: sealed.bytes, file: { path: await paths.wire(path), hash: sealed.hash, size: sealed.bytes.length, revision: title } };
}

it('bounds empty advancing encrypted pages independently of the item budget', async () => {
	const { api, request } = harness();
	request.mockImplementation(async () => Response.json(page([], `cursor-${String(request.mock.calls.length).padStart(5, '0')}`)));
	await expect(api.request('/reading/list')).rejects.toThrow('limit');
	expect(request).toHaveBeenCalledTimes(1000);
});

it('opens only the 10,000 most recently changed notes of a larger library', async () => {
	const { api, request } = harness();
	const hash = 'a'.repeat(64), oldest = `${wireFolder}/oldest.md`;
	const files = Array.from({ length: 10_000 }, (_, file) => ({ path: `${wireFolder}/${file}.md`, hash, size: 1, revision: `r-${file}`, modified: `2026-01-01 00:00:${String(file % 60).padStart(2, '0')}` }));
	files.splice(5_000, 0, { path: oldest, hash, size: 1, revision: 'r-oldest', modified: '2020-01-01 00:00:00' });
	const opened: string[] = [];
	request.mockImplementation(async path => {
		if (path.startsWith('/reading/encrypted-file?')) { opened.push(new URL(path, 'https://crate.invalid').searchParams.get('path')!); return Response.json({ error: 'Not found' }, { status: 404 }); }
		const after = Number(new URL(path, 'https://crate.invalid').searchParams.get('after') ?? 0);
		return Response.json(page(files.slice(after, after + 1000), after + 1000 < files.length ? String(after + 1000).padStart(6, '0') : null));
	});
	// Before: a library over the limit failed to load at all.
	const listed = await api.request('/reading/list') as { omitted?: number };
	expect(listed.omitted).toBe(1);
	expect(opened).toHaveLength(10_000);
	expect(opened).not.toContain(oldest);
});

it.each([['A', 'A'], ['A', 'B', 'A']])('rejects an encrypted cursor cycle: %j', async (...cursors) => {
	const { api, request } = harness();
	for (const cursor of cursors) request.mockResolvedValueOnce(Response.json(page([], cursor)));
	await expect(api.request('/reading/list')).rejects.toThrow('did not advance');
	expect(request).toHaveBeenCalledTimes(cursors.length);
});

it.each([null, { ...page(), nextCursor: {} }, { ...page(), files: [null] }])('rejects a malformed first page: %j', async value => {
	const { api, request } = harness();
	request.mockResolvedValueOnce(Response.json(value));
	await expect(api.request('/reading/list')).rejects.toThrow('Invalid encrypted file');
	expect(request).toHaveBeenCalledOnce();
});

it.each(['later page', 'confirmation'])('rejects a sequence change on the %s', async stage => {
	const { api, request } = harness();
	request.mockResolvedValueOnce(Response.json(page([], stage === 'later page' ? 'A' : null)));
	request.mockResolvedValueOnce(Response.json(page([], null, 2)));
	await expect(api.request('/reading/list')).rejects.toThrow('changed while loading');
	expect(request).toHaveBeenCalledTimes(2);
});

it('rejects repeated file paths across encrypted pages before opening any note', async () => {
	const { api, request } = harness(), saved = await article('Saved');
	request.mockResolvedValueOnce(Response.json(page([saved.file], 'A')))
		.mockResolvedValueOnce(Response.json(page([saved.file])));
	await expect(api.request('/reading/list')).rejects.toThrow('repeated a file');
	expect(request).toHaveBeenCalledTimes(2);
});

it.each(['malformed later page', 'changed confirmation'])('retains the complete inventory and article after a %s', async failure => {
	const { api, request } = harness(), original = await article('Original'), changed = await article('Changed');
	request.mockImplementation(async path => path.startsWith('/reading/encrypted-file?') ? new Response(original.bytes) : Response.json(page([original.file])));
	await expect(api.request('/reading/list')).resolves.toMatchObject({ items: [{ title: 'Original' }], issues: [] });
	// Any change advances the vault sequence.
	request.mockResolvedValueOnce(Response.json(page([changed.file], failure === 'malformed later page' ? 'A' : null, 2)))
		.mockResolvedValueOnce(new Response(changed.bytes))
		.mockResolvedValueOnce(Response.json(failure === 'malformed later page' ? { ...page([], null, 2), nextCursor: {} } : page([], null, 3)));
	await expect(api.request('/reading/list')).rejects.toThrow();
	request.mockClear();
	const restored = await api.request(`/reading/item?id=${itemId}`) as { item: { title: string }; markdown: string };
	expect(restored.item.title).toBe('Original');
	expect(restored.markdown).toContain('Original text.');
	// Both metadata and article bytes still belong to the last complete inventory.
	expect(request.mock.calls.every(([path]) => path.startsWith('/reading/encrypted-files?'))).toBe(true);
});

it('answers an unchanged vault from the confirmed inventory in one request', async () => {
	const { api, request } = harness(), original = await article('Original');
	request.mockImplementation(async path => path.startsWith('/reading/encrypted-file?') ? new Response(original.bytes) : Response.json(page([original.file])));
	const first = await api.request('/reading/list') as { revision: string };
	request.mockClear();
	expect(await api.request('/reading/list')).toEqual(first);
	expect(request).toHaveBeenCalledOnce();
	expect(first.revision).toMatch(/^"e2ee-reading-1-[0-9a-f]{32}"$/);
});

it('opens articles from a recent confirmed inventory and skips a saved revision', async () => {
	const { api, request } = harness(), original = await article('Original');
	request.mockImplementation(async path => path.startsWith('/reading/encrypted-file?') ? new Response(original.bytes) : Response.json(page([original.file])));
	await api.request('/reading/list');
	request.mockClear();
	const opened = await api.item(itemId);
	expect(opened).toMatchObject({ article: { item: { title: 'Original' } } });
	expect(opened?.etag).toMatch(/^"e2ee-file-1-[0-9a-f]{32}"$/);
	// Within 30 seconds of the list, the inventory is not read again.
	expect(request.mock.calls.map(([path]) => path.split('?')[0])).toEqual([]);
	// The note was already decrypted; a copy saved at its revision needs nothing at all.
	expect(await api.item(itemId, opened!.etag)).toBeNull();
	expect(request).not.toHaveBeenCalled();
	const later = Date.now() + 31_000;
	vi.spyOn(Date, 'now').mockReturnValue(later);
	try {
		expect(await api.item(itemId, opened!.etag)).toBeNull();
		expect(request.mock.calls.map(([path]) => path.split('?')[0])).toEqual(['/reading/encrypted-files']);
	} finally { vi.restoreAllMocks(); }
});

async function notes(count: number, revision = 'r1') {
	return Promise.all(Array.from({ length: count }, async (_, i) => {
		const id = `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`;
		const path = `Reading/Note ${String(i).padStart(3, '0')}.md`;
		const text = createReadingNote({ id, url: `https://example.com/${i}`, title: `Note ${i}`, savedAt: '2026-10-01T12:00:00Z' });
		const sealed = await sealFile({ path, content: new TextEncoder().encode(text), contentType: 'text/markdown', publicData: null }, authority);
		return { bytes: sealed.bytes, file: { path: await paths.wire(path), hash: sealed.hash, size: sealed.bytes.length, revision } };
	}));
}
function serve(request: ReturnType<typeof harness>['request'], saved: Awaited<ReturnType<typeof notes>>, sequence = 1) {
	const bytes = new Map(saved.map(note => [note.file.path, note.bytes]));
	request.mockImplementation(async path => {
		if (!path.startsWith('/reading/encrypted-file?')) return Response.json(page(saved.map(note => note.file), null, sequence));
		return new Response(bytes.get(new URL(path, 'https://crate.invalid').searchParams.get('path')!));
	});
}
const downloads = (request: ReturnType<typeof harness>['request']) => request.mock.calls.filter(([path]) => path.startsWith('/reading/encrypted-file?')).length;

it('downloads changed notes a few at a time and keeps page order', async () => {
	const { api, request } = harness(), saved = await notes(20);
	serve(request, saved);
	let active = 0, peak = 0;
	const serveFile = request.getMockImplementation()!;
	request.mockImplementation(async path => {
		if (!path.startsWith('/reading/encrypted-file?')) return serveFile(path);
		active++; peak = Math.max(peak, active);
		await new Promise(resolve => setTimeout(resolve, 1));
		active--;
		return serveFile(path);
	});
	const list = await api.request('/reading/list') as { items: Array<{ title: string }> };
	expect(list.items.map(item => item.title)).toEqual(saved.map((_, i) => `Note ${i}`));
	// Before: one note at a time.
	expect(peak).toBe(6);
	expect(downloads(request)).toBe(20);
});

it('reuses the saved index after a reload and downloads only changed notes', async () => {
	const saved = await notes(10);
	let stored: EncryptedReadingIndexEntry[] | undefined;
	const saveIndex = vi.fn(async (entries: EncryptedReadingIndexEntry[]) => { stored = structuredClone(entries); });
	const reload = () => {
		const request = vi.fn<(path: string) => Promise<Response>>();
		const api = new EncryptedReadingApi({ folderPath: 'Reading', wireFolder, paths, generation: 1, authority, request, loadIndex: async () => stored, saveIndex,
			readAttempt: async () => undefined, writeAttempt: async () => {}, error: message => new Error(message) });
		return { api, request };
	};

	const first = reload();
	serve(first.request, saved);
	await first.api.request('/reading/list');
	expect(downloads(first.request)).toBe(10);
	expect(saveIndex).toHaveBeenCalledOnce();

	// Unchanged library after reload: listing only, no note downloads, no rewrite.
	const unchanged = reload();
	serve(unchanged.request, saved, 2);
	await expect(unchanged.api.request('/reading/list')).resolves.toMatchObject({ items: saved.map((_, i) => ({ title: `Note ${i}` })) });
	expect(downloads(unchanged.request)).toBe(0);
	expect(saveIndex).toHaveBeenCalledOnce();

	// One edited note: only that note is downloaded, and the index is refreshed.
	const edited = [...saved];
	edited[3] = (await notes(4, 'r2'))[3]!;
	const changed = reload();
	serve(changed.request, edited, 3);
	await changed.api.request('/reading/list');
	expect(downloads(changed.request)).toBe(1);
	expect(saveIndex).toHaveBeenCalledTimes(2);
	expect(stored?.find(entry => entry.file.path === edited[3]!.file.path)?.file.revision).toBe('r2');
});

it('keeps the library label and result after edits elsewhere in the vault', async () => {
	const { api, request } = harness(), saved = await notes(5);
	serve(request, saved, 1);
	const first = await api.request('/reading/list') as { revision: string };
	// Before: the label was the vault sequence, so any note edit made the web
	// app rewrite and redraw its whole saved library.
	serve(request, saved, 2);
	const after = await api.request('/reading/list') as { revision: string };
	expect(after).toBe(first);
	expect(downloads(request)).toBe(5);
});

it('changes the library label when an article changes or stops failing', async () => {
	const { api, request } = harness(), saved = await notes(3);
	serve(request, saved, 1);
	const serveFile = request.getMockImplementation()!;
	request.mockImplementation(async path => path.includes(encodeURIComponent(saved[1]!.file.path)) ? new Response(null, { status: 503 }) : serveFile(path));
	const failing = await api.request('/reading/list') as { revision: string; issues: unknown[] };
	expect(failing.issues).toHaveLength(1);

	serve(request, saved, 2);
	const recovered = await api.request('/reading/list') as { revision: string; issues: unknown[] };
	expect(recovered.issues).toHaveLength(0);
	expect(recovered.revision).not.toBe(failing.revision);

	const edited = [saved[0]!, saved[1]!, { ...saved[2]!, file: { ...saved[2]!.file, revision: 'r2' } }];
	serve(request, edited, 3);
	const changed = await api.request('/reading/list') as { revision: string };
	expect(changed.revision).not.toBe(recovered.revision);
});

it('keeps other decrypted notes after committing an edit', async () => {
	const saved = await notes(2), edited = [saved[0]!, (await notes(2, 'r2'))[1]!];
	let current = saved, sequence = 1;
	const request = vi.fn<(path: string, body?: string) => Promise<Response>>(async (path, body) => {
		if (path.startsWith('/reading/encrypted-receipt?')) return Response.json({ envelope: null });
		if (path === '/reading/encrypted-commit') return Response.json({ encrypted: (JSON.parse(body!) as { acknowledgment: string }).acknowledgment });
		if (path.startsWith('/reading/encrypted-files?')) return Response.json(page(current.map(note => note.file), null, sequence));
		const target = new URL(path, 'https://crate.invalid').searchParams.get('path');
		return new Response(current.find(note => note.file.path === target)!.bytes);
	});
	const api = new EncryptedReadingApi({ folderPath: 'Reading', wireFolder, paths, generation: 1, authority, request,
		readAttempt: async () => undefined, writeAttempt: async () => {}, error: message => new Error(message) });
	const list = await api.request('/reading/list') as { items: Array<{ crate_reading_id: string; title: string }> };
	const first = list.items.find(item => item.title === 'Note 0'), second = list.items.find(item => item.title === 'Note 1');
	await api.request('/reading/update', JSON.stringify({ id: second!.crate_reading_id, operationId: 'operation-1', changes: { favorite: true }, before: { favorite: false } }));
	current = edited; sequence = 2; request.mockClear();
	await expect(api.request(`/reading/item?id=${first!.crate_reading_id}`)).resolves.toMatchObject({ item: { title: 'Note 0' } });
	// Only the committed note is downloaded again; the open note stays decrypted.
	expect(request.mock.calls.filter(([path]) => path.startsWith('/reading/encrypted-file?')).map(([path]) => new URL(path, 'https://crate.invalid').searchParams.get('path'))).toEqual([saved[1]!.file.path]);
});

async function note(id: string, name: string, url: string) {
	const path = `Reading/${name}.md`;
	const text = createReadingNote({ id, url, title: name, savedAt: '2026-10-01T12:00:00Z' });
	const sealed = await sealFile({ path, content: new TextEncoder().encode(text), contentType: 'text/markdown', publicData: null }, authority);
	return { bytes: sealed.bytes, file: { path: await paths.wire(path), hash: sealed.hash, size: sealed.bytes.length, revision: 'r1' } };
}
/** Serves `notes` with commits acknowledged; downloads of `failing` server paths fail in transit. */
function library(notes: Array<Awaited<ReturnType<typeof note>>>) {
	const state = { notes, failing: new Set<string>(), sequence: 1 };
	const request = vi.fn<(path: string, body?: string) => Promise<Response>>(async (path, body) => {
		if (path === '/reading/encrypted-commit') return Response.json({ encrypted: (JSON.parse(body!) as { acknowledgment: string }).acknowledgment });
		if (path.startsWith('/reading/encrypted-files?')) return Response.json(page(state.notes.map(note => note.file), null, state.sequence));
		const target = new URL(path, 'https://crate.invalid').searchParams.get('path')!;
		if (state.failing.has(target)) return new Response(null, { status: 503 });
		return new Response(state.notes.find(note => note.file.path === target)!.bytes);
	});
	const api = new EncryptedReadingApi({ folderPath: 'Reading', wireFolder, paths, generation: 1, authority, request,
		readAttempt: async () => undefined, writeAttempt: async () => {}, error: (message, status, code) => Object.assign(new Error(message), { status, code }) });
	const commits = () => request.mock.calls.filter(([path]) => path === '/reading/encrypted-commit').length;
	return { api, state, commits, request };
}
const favorite = (id: string, operationId: string) => JSON.stringify({ id, operationId, changes: { favorite: true }, before: { favorite: false } });
const save = (url: string, operationId: string) => JSON.stringify({ url, operationId, fetchArticle: false });
const retryable = { status: 503, code: 'reading_unavailable' };
const readingId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

it('edits other notes while one is unreadable, but keeps captures and changes it may hide retryable', async () => {
	const kept = await note(readingId(201), 'Kept', 'https://example.com/kept'), unread = await note(readingId(202), 'Unread', 'https://example.com/unread');
	const { api, state, commits } = library([kept, unread]);
	// Before: any unreadable note refused every change with this retryable error.
	state.failing.add(unread.file.path);
	await expect(api.request('/reading/update', favorite(readingId(201), 'edit-kept'))).resolves.toEqual({ saved: true, id: readingId(201) });
	expect(commits()).toBe(1);
	// This device never read the failing note, so it may hold any ID or link.
	await expect(api.request('/reading/update', favorite(readingId(202), 'edit-unread'))).rejects.toMatchObject(retryable);
	await expect(api.request('/reading/update', favorite(readingId(299), 'edit-missing'))).rejects.toMatchObject(retryable);
	await expect(api.request('/reading/capture', save('https://example.com/unread', 'save-unread'))).rejects.toMatchObject(retryable);
	expect(commits()).toBe(1);

	state.failing.clear(); state.sequence = 2;
	await expect(api.request('/reading/capture', save('https://example.com/unread', 'save-unread'))).resolves.toMatchObject({ alreadySaved: true, id: readingId(202) });
	await expect(api.request('/reading/update', favorite(readingId(299), 'edit-missing'))).rejects.toMatchObject({ code: 'reading_conflict' });
	await expect(api.request('/reading/capture', save('https://example.com/new', 'save-new'))).resolves.toMatchObject({ saved: true });
	expect(commits()).toBe(2);
});

it('keeps an edit retryable while a note last verified with its ID is unreadable', async () => {
	const original = await note(readingId(211), 'Original', 'https://example.com/original');
	const { api, state, commits } = library([original]);
	await api.request('/reading/list');
	// The note changes elsewhere and its new revision fails to download.
	const changed = { ...original, file: { ...original.file, revision: 'r2' } };
	state.notes = [changed]; state.failing.add(original.file.path); state.sequence = 2;
	await expect(api.request('/reading/update', favorite(readingId(211), 'edit-1'))).rejects.toMatchObject(retryable);
	// A readable copy with the same ID is listed as unique, but may not be the note the change was made on.
	state.notes = [changed, await note(readingId(211), 'Copy', 'https://example.com/original')]; state.sequence = 3;
	await expect(api.request('/reading/list')).resolves.toMatchObject({ items: [{ title: 'Copy' }] });
	await expect(api.request('/reading/update', favorite(readingId(211), 'edit-2'))).rejects.toMatchObject(retryable);
	expect(commits()).toBe(0);
});

it('saves links and edits other notes while two notes share a Reading ID, without choosing either', async () => {
	const unique = await note(readingId(221), 'Unique', 'https://example.com/unique');
	const first = await note(readingId(222), 'First', 'https://example.com/first'), second = await note(readingId(222), 'Second', 'https://example.com/second');
	const { api, commits } = library([unique, first, second]);
	await expect(api.request('/reading/list')).resolves.toMatchObject({ items: [{ title: 'Unique' }], issues: [{}, {}] });
	const duplicate = { ...retryable, message: READING_DUPLICATE_ID_ISSUE };
	await expect(api.request('/reading/update', favorite(readingId(222), 'edit-duplicate'))).rejects.toMatchObject(duplicate);
	// The link is saved, but its ID cannot be answered until the duplicates are resolved.
	await expect(api.request('/reading/capture', save('https://example.com/second', 'save-duplicate'))).rejects.toMatchObject(duplicate);
	expect(commits()).toBe(0);
	await expect(api.request('/reading/update', favorite(readingId(221), 'edit-unique'))).resolves.toMatchObject({ saved: true });
	await expect(api.request('/reading/capture', save('https://example.com/new', 'save-new'))).resolves.toMatchObject({ saved: true });
	expect(commits()).toBe(2);
});

it('refuses edits with the wording and status the plaintext Worker sends', async () => {
	const plain = await note(readingId(231), 'Plain', 'https://example.com/plain');
	// A capture whose article was already saved cannot be downloaded again.
	const empty = createReadingNote({ id: readingId(232), url: 'https://example.com/saved', title: 'Saved', savedAt: '2026-10-01T12:00:00Z' });
	const block = managedArticle(empty)!, text = `${empty.slice(0, block.start)}\nSaved text\n${empty.slice(block.end)}`;
	const sealed = await sealFile({ path: 'Reading/Saved.md', content: new TextEncoder().encode(text), contentType: 'text/markdown', publicData: null }, authority);
	const { api, commits } = library([plain, { bytes: sealed.bytes, file: { path: await paths.wire('Reading/Saved.md'), hash: sealed.hash, size: sealed.bytes.length, revision: 'r1' } }]);
	let operations = 0;
	const edit = (action: string, body: Record<string, unknown>) => api.request(`/reading/${action}`, JSON.stringify({ operationId: `refused-${++operations}`, ...body }));
	const refused = (issue: 'invalid' | 'unsupported' | 'conflict' | 'not-empty', action: 'delete' | 'retry' | 'update') => readingFileCommandRefusal({ kind: 'issue', issue }, action);
	await expect(edit('update', { id: readingId(231), changes: [], before: {} })).rejects.toMatchObject(refused('invalid', 'update'));
	await expect(edit('update', { id: readingId(231), changes: { source_url: 'https://other.example' }, before: {} })).rejects.toMatchObject(refused('unsupported', 'update'));
	await expect(edit('update', { id: readingId(231), changes: { favorite: false }, before: { favorite: true } })).rejects.toMatchObject(refused('conflict', 'update'));
	await expect(edit('delete', { id: readingId(231), before: { favorite: true }, markdownHash: '0'.repeat(64) })).rejects.toMatchObject(refused('conflict', 'delete'));
	await expect(edit('retry', { id: readingId(232) })).rejects.toMatchObject(refused('not-empty', 'retry'));
	expect(commits()).toBe(0);
	// The case the two clients used to word differently: both now settle it for review with status 400.
	expect(refused('not-empty', 'retry')).toEqual({ message: 'Only URL captures with an unchanged article section can be extracted.', status: 400 });
});

it('rejects a commit refused with a non-JSON body with its status and a short message', async () => {
	const kept = await note(readingId(241), 'Kept', 'https://example.com/kept');
	const { api, request } = library([kept]);
	const serve = request.getMockImplementation()!;
	// A reverse proxy refuses the body before it reaches the Worker.
	request.mockImplementation(async (path, body) => path === '/reading/encrypted-commit'
		? new Response('<html><body>413 Request Entity Too Large</body></html>', { status: 413, headers: { 'content-type': 'text/html' } })
		: serve(path, body));
	await expect(api.request('/reading/update', favorite(readingId(241), 'edit-too-large'))).rejects.toMatchObject({ status: 413, message: 'Reading request failed.' });
	// So does a proxy's conflict page, which is not the Worker's version conflict.
	request.mockImplementation(async (path, body) => path === '/reading/encrypted-commit'
		? new Response('<html>Conflict</html>', { status: 409, headers: { 'content-type': 'text/html' } })
		: serve(path, body));
	await expect(api.request('/reading/update', favorite(readingId(241), 'edit-proxy-conflict'))).rejects.toMatchObject({ status: 409, message: 'Reading request failed.' });
});

it('names a failed note by its plaintext path and retries it at the same sequence', async () => {
	const { api, request } = harness(), saved = await notes(2), edited = [saved[0]!, (await notes(2, 'r2'))[1]!];
	serve(request, saved, 1);
	await api.request('/reading/list');
	serve(request, edited, 2);
	const serveFile = request.getMockImplementation()!;
	request.mockImplementation(async path => path.startsWith('/reading/encrypted-file?') ? new Response(null, { status: 503 }) : serveFile(path));
	for (let attempt = 0; attempt < 2; attempt++) {
		await expect(api.request('/reading/list')).resolves.toMatchObject({ issues: [{ path: 'Reading/Note 001.md' }] });
	}
	// The server recovers without a new vault sequence.
	request.mockImplementation(serveFile);
	await expect(api.request('/reading/list')).resolves.toMatchObject({ issues: [], items: [{ title: 'Note 0' }, { title: 'Note 1' }] });
});

it('rejects an oversized encrypted note before downloading it', async () => {
	const { api, request } = harness(), saved = await article('Saved');
	request.mockImplementation(async () => Response.json(page([{ ...saved.file, size: 4 * 1024 * 1024 + 1 }])));
	await expect(api.request('/reading/list')).resolves.toMatchObject({ issues: [{ path: saved.file.path, message: 'This Reading note is too large.' }] });
	expect(request.mock.calls.some(([path]) => path.startsWith('/reading/encrypted-file?'))).toBe(false);
});

it('saves a bookmark marked unavailable when the server will not download its article', async () => {
	const commits: string[] = [];
	const request = vi.fn<(path: string, body?: string) => Promise<Response>>(async (path, body) => {
		if (path !== '/reading/encrypted-commit') return Response.json(page());
		commits.push(body!);
		return Response.json({ encrypted: (JSON.parse(body!) as { acknowledgment: string }).acknowledgment });
	});
	// The server refuses while article fetching is off.
	const extract = vi.fn(async () => Response.json({ error: 'Allow article fetching in Reading settings before downloading articles.', code: 'reading_fetching_off' }, { status: 403 }));
	const api = new EncryptedReadingApi({ folderPath: 'Reading', wireFolder, paths, generation: 1, authority, request,
		captureArticle: url => captureServerArticle(url, extract),
		readAttempt: async () => undefined, writeAttempt: async () => {}, error: message => new Error(message) });
	await expect(api.request('/reading/capture', JSON.stringify({ url: 'https://example.com/off', operationId: 'save-off', fetchArticle: true }))).resolves.toMatchObject({ saved: true });
	expect(extract).toHaveBeenCalledOnce();
	const [committed] = (JSON.parse(commits[0]!) as { files: Array<{ content: string }> }).files;
	const opened = await openFile(new TextEncoder().encode(committed!.content), async path => path, authority);
	expect(parseReadingNote(new TextDecoder().decode(opened.content))).toMatchObject({ source_url: 'https://example.com/off', extraction_status: 'unavailable' });
});
