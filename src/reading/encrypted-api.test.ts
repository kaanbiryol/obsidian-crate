import { beforeAll, expect, it, vi } from 'vitest';
import { generateEncryptionSecret, importEncryptionSecret } from '@/encryption/envelope';
import { sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import type { EncryptedInventoryFile } from '@/encryption/file-inventory';
import { EncryptedReadingApi } from './encrypted-api';
import { createReadingNote } from './core/notes';

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
	request.mockResolvedValueOnce(Response.json(page([changed.file], failure === 'malformed later page' ? 'A' : null)))
		.mockResolvedValueOnce(new Response(changed.bytes))
		.mockResolvedValueOnce(Response.json(failure === 'malformed later page' ? { ...page(), nextCursor: {} } : page([], null, 2)));
	await expect(api.request('/reading/list')).rejects.toThrow();
	request.mockClear();
	const restored = await api.request(`/reading/item?id=${itemId}`) as { item: { title: string }; markdown: string };
	expect(restored.item.title).toBe('Original');
	expect(restored.markdown).toContain('Original text.');
	// Both metadata and article bytes still belong to the last complete inventory.
	expect(request.mock.calls.every(([path]) => path.startsWith('/reading/encrypted-files?'))).toBe(true);
});
