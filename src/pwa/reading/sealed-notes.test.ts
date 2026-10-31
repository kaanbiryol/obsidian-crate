import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createVaultKeyBundle } from '@/encryption/key-bundle';
import { FileKeyAuthority } from '@/encryption/file-authority';
import { sealFile, type FileEncryptionAuthority } from '@/encryption/file-codec';
import { sealFileForVault, type SealRecipient } from '@/encryption/sealed-file';
import type { EncryptedInventoryFile } from '@/encryption/file-inventory';
import { PathTags } from '@/encryption/path-tags';
import { createOpaqueWireName } from '@/protocol/encrypted-path';
import { createReadingNote } from '../../reading/core/notes';
import { EncryptedReadingApi, type EncryptedReadingIndexEntry } from './encrypted-api';
import { acceptsSealedNote } from './sealed-notes';

describe('acceptsSealedNote', () => {
	const note = { wire: 'R/new.md', path: 'Reading/Article.md', hash: 'a' };
	it('accepts a note at a new server path under a free name', () => {
		expect(acceptsSealedNote(note, [])).toBe(true);
		expect(acceptsSealedNote(note, [{ wire: 'R/other.md', path: 'Reading/Other.md', hash: 'b' }])).toBe(true);
	});
	it('accepts a known server path only with the plaintext and name held there', () => {
		expect(acceptsSealedNote(note, [{ ...note }])).toBe(true);
		expect(acceptsSealedNote(note, [{ ...note, hash: 'b' }])).toBe(false);
		expect(acceptsSealedNote(note, [{ ...note, path: 'Reading/Renamed.md' }])).toBe(false);
	});
	it('rejects the name of a note at another server path, in any letter case', () => {
		expect(acceptsSealedNote(note, [{ wire: 'R/old.md', path: 'Reading/Article.md', hash: 'a' }])).toBe(false);
		expect(acceptsSealedNote(note, [{ wire: 'R/old.md', path: 'reading/ARTICLE.md', hash: 'b' }])).toBe(false);
	});
});

let authority: FileEncryptionAuthority, recipient: SealRecipient, paths: PathTags, wireFolder: string;
beforeAll(async () => {
	const bundle = await createVaultKeyBundle();
	authority = (await FileKeyAuthority.fromBundle(bundle)).forPath('Reading/note.md');
	recipient = { vaultId: bundle.vaultId, keyId: bundle.seal.id, publicKey: bundle.seal.publicKey };
	paths = await PathTags.fromSecret(bundle.vaultId, bundle.vault);
	wireFolder = await paths.wire('Reading');
});
const readingId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
interface Note { bytes: Uint8Array<ArrayBuffer>; file: EncryptedInventoryFile }
const text = (n: number, title: string, body = '') => new TextEncoder().encode(createReadingNote({ id: readingId(n), url: `https://example.com/${n}`, title, savedAt: '2026-10-01T12:00:00Z' }) + body);
/** A note saved with the vault key, at its tagged server path unless `wire` is given. */
async function vaultNote(n: number, title: string, wire?: string): Promise<Note> {
	const path = `Reading/${title}.md`;
	const sealed = await sealFile({ path, content: text(n, title), contentType: 'text/markdown', publicData: null }, authority);
	return { bytes: sealed.bytes, file: { path: wire ?? await paths.wire(path), hash: sealed.hash, size: sealed.bytes.length, revision: crypto.randomUUID() } };
}
/** A note the server sealed, as the Shortcut saves one, under a random server name unless `wire` is given. */
async function serverNote(n: number, title: string, wire = `${wireFolder}/${createOpaqueWireName()}`, body = ''): Promise<Note> {
	const sealed = await sealFileForVault({ path: `${wireFolder}/${title}.md`, content: text(n, title, body), contentType: 'text/markdown' }, recipient);
	return { bytes: sealed.bytes, file: { path: wire, hash: sealed.hash, size: sealed.bytes.length, revision: crypto.randomUUID() } };
}

/** A web app whose index persists across reloads, serving `state.notes`. */
function webApp() {
	const state = { notes: [] as Note[], sequence: 0, stored: undefined as EncryptedReadingIndexEntry[] | undefined };
	const request = vi.fn<(path: string) => Promise<Response>>(async path => {
		if (path.startsWith('/reading/encrypted-files?')) return Response.json({ files: state.notes.map(note => note.file), nextCursor: null, sequence: state.sequence, generation: 1 });
		const target = new URL(path, 'https://crate.invalid').searchParams.get('path');
		return new Response(state.notes.find(note => note.file.path === target)!.bytes);
	});
	const open = () => new EncryptedReadingApi({ folderPath: 'Reading', wireFolder, paths, generation: 1, authority, request,
		loadIndex: async () => structuredClone(state.stored), saveIndex: async entries => { state.stored = structuredClone(entries); },
		readAttempt: async () => undefined, writeAttempt: async () => {}, error: message => new Error(message) });
	let api = open();
	const list = async (notes: Note[], { reload = false } = {}) => {
		state.notes = notes; state.sequence++;
		if (reload) api = open();
		return await api.request('/reading/list') as { items: Array<{ title: string; path: string }>; issues: Array<{ path: string; message: string }> };
	};
	return { list, item: (n: number) => api.request(`/reading/item?id=${readingId(n)}`) as Promise<{ markdown: string }> };
}
const rejected = (path: string) => ({ path, message: expect.stringContaining('The server created a note') as unknown });

describe('sealed notes in the encrypted web app', () => {
	it('keeps opening a Shortcut note, its unchanged copies and its edits', async () => {
		const app = webApp(), saved = await serverNote(1, 'Shared');
		await expect(app.list([saved])).resolves.toMatchObject({ items: [{ title: 'Shared', path: 'Reading/Shared.md' }], issues: [] });
		// The same plaintext under a new revision changes nothing.
		const copy = { ...saved, file: { ...saved.file, revision: 'copy' } };
		await expect(app.list([copy], { reload: true })).resolves.toMatchObject({ items: [{ title: 'Shared' }], issues: [] });
		// An edit re-saves it with the vault key under its server name.
		const edited = await vaultNote(1, 'Shared', saved.file.path);
		await expect(app.list([edited], { reload: true })).resolves.toMatchObject({ items: [{ title: 'Shared' }], issues: [] });
	});

	it('rejects a sealed note over a note it holds and keeps naming the held note after a reload', async () => {
		const app = webApp(), held = await vaultNote(2, 'Held');
		await app.list([held]);
		// Before: the forged note was listed and opened in place of the real one.
		const forged = await serverNote(2, 'Held', held.file.path, '\nForged.\n');
		await expect(app.list([forged])).resolves.toEqual(expect.objectContaining({ items: [], issues: [rejected('Reading/Held.md')] }));
		await expect(app.list([forged], { reload: true })).resolves.toEqual(expect.objectContaining({ items: [], issues: [rejected('Reading/Held.md')] }));
		await expect(app.item(2)).rejects.toThrow('unavailable');
		await expect(app.list([held], { reload: true })).resolves.toMatchObject({ items: [{ title: 'Held' }], issues: [] });
	});

	it('rejects a sealed note over an untouched Shortcut note', async () => {
		const app = webApp(), saved = await serverNote(3, 'Shortcut');
		await app.list([saved]);
		const forged = await serverNote(3, 'Shortcut', saved.file.path, '\nForged.\n');
		await expect(app.list([forged], { reload: true })).resolves.toEqual(expect.objectContaining({ items: [], issues: [rejected('Reading/Shortcut.md')] }));
	});

	it('rejects a sealed note named like another note and keeps that note', async () => {
		const app = webApp(), held = await vaultNote(4, 'Named');
		// Before: both were listed under one name and the real note opened the forged text.
		const forged = await serverNote(5, 'Named');
		for (const reload of [false, true]) {
			await expect(app.list([held, forged], { reload })).resolves.toEqual(expect.objectContaining({ items: [expect.objectContaining({ title: 'Named' })], issues: [rejected(forged.file.path)] }));
		}
		await expect(app.item(4)).resolves.toMatchObject({ markdown: expect.any(String) as unknown });
		await expect(app.list([held, await serverNote(6, 'Fresh')])).resolves.toMatchObject({ items: [{ title: 'Named' }, { title: 'Fresh' }], issues: [] });
	});
});
