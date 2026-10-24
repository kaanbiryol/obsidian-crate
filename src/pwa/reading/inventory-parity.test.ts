import { beforeAll, expect, it, vi } from 'vitest';
import { generateEncryptionSecret, importEncryptionSecret } from '@/encryption/envelope';
import { sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import { ReadingLibrary, type ReadingVault } from '@/reading/data/library';
import { createReadingNote } from '@/reading/core/notes';
import { findSavedReadingLink } from '@/reading/core/inventory';
import type { ReadingItem } from '@/reading/core/model';
import { PathTags } from '@/encryption/path-tags';
import { EncryptedReadingApi } from './encrypted-api';

let authority: FileEncryptionAuthority;
// The server lists notes by tagged paths inside the tagged Reading folder.
let paths: PathTags, wireFolder: string;
beforeAll(async () => {
	authority = { vaultId: 'vault-a', scopeId: 'reading-a', key: await importEncryptionSecret(generateEncryptionSecret()) };
	paths = await PathTags.fromSecret('vault-a', generateEncryptionSecret());
	wireFolder = await paths.wire('Reading');
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const note = (n: number, url: string) => createReadingNote({ id: id(n), url, title: `Note ${n}`, savedAt: `2026-10-0${n}T12:00:00Z` });
// One shared ID (two files) and two distinct notes saving the same link.
const notes = new Map([
	['Reading/A.md', note(1, 'https://example.com/a')],
	['Reading/B.md', note(2, 'https://example.com/shared')],
	['Reading/B copy.md', note(2, 'https://example.com/shared')],
	['Reading/C.md', note(3, 'https://youtu.be/jNQXAC9IVRw')],
	['Reading/D.md', note(4, 'https://www.youtube.com/watch?v=jNQXAC9IVRw#t=1')],
]);

async function pluginInventory() {
	const vault: ReadingVault = { files: () => [...notes].map(([path, content]) => ({ path, modifiedAt: 0, size: content.length })),
		read: async file => notes.get(file.path)!, process: async () => { throw new Error('Read only'); }, create: async () => { throw new Error('Read only'); } };
	const library = new ReadingLibrary(vault, 'Reading', new AbortController().signal, () => true);
	await library.refresh();
	return library.getSnapshot();
}

async function pwaInventory() {
	const sealed = await Promise.all([...notes].map(async ([path, content]) => {
		const result = await sealFile({ path, content: new TextEncoder().encode(content), contentType: 'text/markdown', publicData: null }, authority);
		return { bytes: result.bytes, file: { path: await paths.wire(path), hash: result.hash, size: result.bytes.length, revision: 'r1' } };
	}));
	const bytes = new Map(sealed.map(entry => [entry.file.path, entry.bytes]));
	const request = vi.fn(async (path: string) => path.startsWith('/reading/encrypted-file?')
		? new Response(bytes.get(new URL(path, 'https://crate.invalid').searchParams.get('path')!))
		: Response.json({ files: sealed.map(entry => entry.file), nextCursor: null, sequence: 1, generation: 1 }));
	const api = new EncryptedReadingApi({ folderPath: 'Reading', wireFolder, paths, generation: 1, authority, request,
		readAttempt: async () => undefined, writeAttempt: async () => {}, error: message => new Error(message) });
	return await api.request('/reading/list') as { items: ReadingItem[]; issues: Array<{ path: string }> };
}

it('plugin and PWA inventories agree on duplicate IDs and saved links', async () => {
	const [plugin, pwa] = await Promise.all([pluginInventory(), pwaInventory()]);
	const ids = (items: ReadingItem[]) => items.map(item => item.crate_reading_id).sort();
	expect(ids(plugin.items)).toEqual([id(1), id(3), id(4)]);
	expect(ids(pwa.items)).toEqual(ids(plugin.items));
	expect(pwa.issues.map(issue => issue.path).sort()).toEqual(plugin.issues.map(issue => issue.path).sort());
	expect(plugin.issues.map(issue => issue.path).sort()).toEqual(['Reading/B copy.md', 'Reading/B.md']);
	for (const url of ['https://example.com/a', 'https://example.com/shared', 'https://www.youtube.com/watch?v=jNQXAC9IVRw']) {
		const pluginLink = findSavedReadingLink(plugin.items, url), pwaLink = findSavedReadingLink(pwa.items, url);
		expect(pwaLink.kind).toBe(pluginLink.kind);
		if (pluginLink.kind === 'one' && pwaLink.kind === 'one') expect(pwaLink.item.crate_reading_id).toBe(pluginLink.item.crate_reading_id);
	}
	expect(findSavedReadingLink(plugin.items, 'https://www.youtube.com/watch?v=jNQXAC9IVRw').kind).toBe('many');
});
