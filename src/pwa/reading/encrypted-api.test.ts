import { beforeAll, expect, it, vi } from 'vitest';
import { generateEncryptionSecret, importEncryptionSecret } from '@/encryption/envelope';
import { sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import type { EncryptedInventoryFile } from '@/encryption/file-inventory';
import { EncryptedReadingApi, type EncryptedReadingIndexEntry } from './encrypted-api';
import { createReadingNote } from '../../reading/core/notes';

let authority: FileEncryptionAuthority;
beforeAll(async () => { authority = { vaultId: 'vault-a', scopeId: 'reading-a', key: await importEncryptionSecret(generateEncryptionSecret()) }; });
const page = (files: EncryptedInventoryFile[] = [], nextCursor: string | null = null, sequence = 1) => ({ files, nextCursor, sequence, generation: 1 });
const itemId = '00000000-0000-4000-8000-000000000001';
function harness() {
	const request = vi.fn<(path: string) => Promise<Response>>(async () => { throw new Error('Unexpected request'); });
	const api = new EncryptedReadingApi({ folderPath: 'Reading', generation: 1, authority, request,
		readAttempt: async () => undefined, writeAttempt: async () => {}, error: message => new Error(message) });
	return { api, request };
}
async function article(title: string) {
	const path = 'Reading/Article.md';
	const text = createReadingNote({ id: itemId, url: 'https://example.com/article', title, savedAt: '2026-10-01T12:00:00Z' }) + `\n${title} text.\n`;
	const sealed = await sealFile({ path, content: new TextEncoder().encode(text), contentType: 'text/markdown', publicData: null }, authority);
	return { bytes: sealed.bytes, file: { path, hash: sealed.hash, size: sealed.bytes.length, revision: title } };
}

it('bounds empty advancing encrypted pages independently of the item budget', async () => {
	const { api, request } = harness();
	request.mockImplementation(async () => Response.json(page([], `cursor-${String(request.mock.calls.length).padStart(5, '0')}`)));
	await expect(api.request('/reading/list')).rejects.toThrow('limit');
	expect(request).toHaveBeenCalledTimes(1000);
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

it('rejects repeated file paths across encrypted pages', async () => {
	const { api, request } = harness(), saved = await article('Saved');
	request.mockResolvedValueOnce(Response.json(page([saved.file], 'A')))
		.mockResolvedValueOnce(new Response(saved.bytes))
		.mockResolvedValueOnce(Response.json(page([saved.file])));
	await expect(api.request('/reading/list')).rejects.toThrow('repeated a file');
	expect(request).toHaveBeenCalledTimes(3);
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

async function notes(count: number, revision = 'r1') {
	return Promise.all(Array.from({ length: count }, async (_, i) => {
		const id = `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`;
		const path = `Reading/Note ${String(i).padStart(3, '0')}.md`;
		const text = createReadingNote({ id, url: `https://example.com/${i}`, title: `Note ${i}`, savedAt: '2026-10-01T12:00:00Z' });
		const sealed = await sealFile({ path, content: new TextEncoder().encode(text), contentType: 'text/markdown', publicData: null }, authority);
		return { bytes: sealed.bytes, file: { path, hash: sealed.hash, size: sealed.bytes.length, revision } };
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
		const api = new EncryptedReadingApi({ folderPath: 'Reading', generation: 1, authority, request, loadIndex: async () => stored, saveIndex,
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
	const api = new EncryptedReadingApi({ folderPath: 'Reading', generation: 1, authority, request,
		readAttempt: async () => undefined, writeAttempt: async () => {}, error: message => new Error(message) });
	const list = await api.request('/reading/list') as { items: Array<{ crate_reading_id: string; title: string }> };
	const first = list.items.find(item => item.title === 'Note 0'), second = list.items.find(item => item.title === 'Note 1');
	await api.request('/reading/update', JSON.stringify({ id: second!.crate_reading_id, operationId: 'operation-1', changes: { favorite: true }, before: { favorite: false } }));
	current = edited; sequence = 2; request.mockClear();
	await expect(api.request(`/reading/item?id=${first!.crate_reading_id}`)).resolves.toMatchObject({ item: { title: 'Note 0' } });
	// Only the committed note is downloaded again; the open note stays decrypted.
	expect(request.mock.calls.filter(([path]) => path.startsWith('/reading/encrypted-file?')).map(([path]) => new URL(path, 'https://crate.invalid').searchParams.get('path'))).toEqual([saved[1]!.file.path]);
});

it('rejects an oversized encrypted note before downloading it', async () => {
	const { api, request } = harness(), saved = await article('Saved');
	request.mockImplementation(async () => Response.json(page([{ ...saved.file, size: 4 * 1024 * 1024 + 1 }])));
	await expect(api.request('/reading/list')).resolves.toMatchObject({ issues: [{ path: saved.file.path, message: 'This Reading note is too large.' }] });
	expect(request.mock.calls.some(([path]) => path.startsWith('/reading/encrypted-file?'))).toBe(false);
});
