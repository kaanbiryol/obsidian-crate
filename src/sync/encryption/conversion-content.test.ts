import { expect, it } from 'vitest';
import { FileKeyAuthority } from '../../encryption/file-authority';
import { openFile, sealFile } from '../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { decryptJson } from '../../encryption/envelope';
import { addReminderScope, createVaultKeyBundle, moveEncryptionScopes } from '../../encryption/key-bundle';
import { computeHash } from '../hasher';
import { prepareConversionFile, prepareConversionReceipt, type ConversionFile } from './conversion-content';

async function fixture(path = 'note.md') {
	const bundle = addReminderScope(addReminderScope(addReminderScope(createVaultKeyBundle(), 'Reminders'), 'Other'), 'Reading', 'reading');
	const keys = await FileKeyAuthority.fromVault(bundle);
	const body = new TextEncoder().encode('Original private note.').buffer;
	const file: ConversionFile = { path, revision: 'original', hash: await computeHash(body), size: body.byteLength };
	return { bundle, keys, body, file };
}

it.each(['plaintext', 'encrypted-looking'])('uses authoritative original bytes for %s files', async kind => {
	const h = await fixture();
	const body = kind === 'plaintext' ? h.body : (await sealFile({ path: h.file.path, content: new Uint8Array(h.body), contentType: 'text/markdown' }, h.keys.forPath(h.file.path))).bytes.buffer;
	const file = { ...h.file, hash: await computeHash(body), size: body.byteLength };
	const prepared = await prepareConversionFile(file, body, null, h.bundle, h.keys);
	const opened = await openFile(prepared.bytes, file.path, h.keys.forPath(file.path));
	expect(opened.content).toEqual(new Uint8Array(body));
	expect(prepared.plainHash).toBe(file.hash);
	expect(opened.metadata.contentType).toBe('application/octet-stream');
});

it('reuses the exact authenticated replacement after interruption', async () => {
	const h = await fixture();
	const first = await prepareConversionFile(h.file, h.body, 'text/markdown', h.bundle, h.keys);
	const replay = await prepareConversionFile(h.file, first.bytes.buffer, ENCRYPTED_FILE_CONTENT_TYPE, h.bundle, h.keys);
	expect(replay.bytes).toEqual(first.bytes);
	expect(replay.plainHash).toBe(h.file.hash);
});

it.each(['original corruption', 'replacement hash', 'replacement size', 'replacement content type', 'replacement corruption'] as const)('refuses %s before publication', async failure => {
	const h = await fixture();
	const sealed = await prepareConversionFile(h.file, h.body, 'text/markdown', h.bundle, h.keys);
	let body = sealed.bytes.buffer, contentType = ENCRYPTED_FILE_CONTENT_TYPE;
	if (failure === 'original corruption') { body = new TextEncoder().encode('Damaged original.').buffer; contentType = 'text/markdown'; }
	if (failure === 'replacement hash') h.file.hash = 'b'.repeat(64);
	if (failure === 'replacement size') h.file.size++;
	if (failure === 'replacement content type') contentType = 'text/plain';
	if (failure === 'replacement corruption') { const bytes = new Uint8Array(body.slice(0)); bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1; body = bytes.buffer; }
	await expect(prepareConversionFile(h.file, body, contentType, h.bundle, h.keys)).rejects.toThrow();
});

it('converts prior-scope ciphertext, authenticates resumed bytes, and rejects a different valid note', async () => {
	const h = await fixture('Reading/note.md');
	const old = await sealFile({ path: h.file.path, content: new Uint8Array(h.body), contentType: 'text/markdown' }, h.keys.forPath(h.file.path));
	const moved = moveEncryptionScopes(h.bundle, 'Reading', 'Articles'), keys = await FileKeyAuthority.fromVault(moved);
	const file = { ...h.file, hash: old.hash, size: old.bytes.byteLength, previous_descriptor: JSON.stringify(old.descriptor) };
	const prepared = await prepareConversionFile(file, old.bytes.buffer, ENCRYPTED_FILE_CONTENT_TYPE, moved, keys);
	expect((await openFile(prepared.bytes, file.path, keys.forPath(file.path))).content).toEqual(new Uint8Array(h.body));
	expect(prepared.plainHash).toBe(h.file.hash);
	expect((await prepareConversionFile(file, prepared.bytes.buffer, ENCRYPTED_FILE_CONTENT_TYPE, moved, keys)).bytes).toEqual(prepared.bytes);
	const unrelated = await sealFile({ path: file.path, content: new TextEncoder().encode('Different note.'), contentType: 'text/markdown' }, keys.forPath(file.path));
	await expect(prepareConversionFile(file, unrelated.bytes.buffer, ENCRYPTED_FILE_CONTENT_TYPE, moved, keys)).rejects.toThrow('does not match');
});

it.each([
	{ kind: 'reminder' as const, response: { reminder: { filePath: 'Reminders/note.md', content: 'Private reminder' } }, folders: ['Reminders'] },
	{ kind: 'reminder' as const, response: { reminder: { filePath: 'Reminders-private/note.md' } }, folders: [] },
	{ kind: 'reminder' as const, response: { reminder: { filePath: null } }, folders: [] },
	{ kind: 'reminder' as const, response: { success: true }, folders: ['Reminders', 'Other', 'Reading'] },
	{ kind: 'reading' as const, response: { id: 'reading-result' }, folders: ['Reading'] },
	{ kind: 'upload' as const, response: { path: 'private.md', hash: 'private hash' }, folders: [] },
])('preserves the $kind receipt audience: $folders', async ({ kind, response, folders }) => {
	const h = await fixture(), operationId = 'operation-id';
	const prepared = await prepareConversionReceipt({ operation_id: operationId, request_hash: 'request-hash', response_json: JSON.stringify(response) }, kind, h.bundle, h.keys);
	const expected = { ...(kind === 'upload' ? { kind } : {}), requestHash: 'request-hash', response };
	const context = { vaultId: h.bundle.vaultId, scopeId: 'vault', objectId: operationId, purpose: 'reminder' as const };
	expect(await decryptJson(prepared.vault, h.keys.forVaultMetadata().key, context)).toEqual(expected);
	expect(prepared.scopes.map(scope => h.bundle.scopes.find(key => key.id === scope.id)!.folderPath)).toEqual(folders);
	for (const scope of prepared.scopes) {
		const folder = h.bundle.scopes.find(key => key.id === scope.id)!.folderPath;
		expect(await decryptJson(scope.envelope, h.keys.forPath(folder + '/receipt.md').key, { ...context, scopeId: scope.id })).toEqual(expected);
	}
});
