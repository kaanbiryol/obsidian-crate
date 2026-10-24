import { expect, it } from 'vitest';
import { FileKeyAuthority } from '../../encryption/file-authority';
import { openFile, sealFile } from '../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { decryptJson } from '../../encryption/envelope';
import { createVaultKeyBundle } from '../../encryption/key-bundle';
import { prepareConversionFile, prepareConversionReceipt, type ConversionFile } from './conversion-content';
import { sha256Hex } from '../../platform/sha256';

async function fixture(path = 'note.md') {
	const bundle = await createVaultKeyBundle();
	const keys = await FileKeyAuthority.fromBundle(bundle);
	const project = async () => null;
	const body = new TextEncoder().encode('Original private note.').buffer;
	const file: ConversionFile = { path, revision: 'original', hash: await sha256Hex(body), size: body.byteLength };
	return { bundle, keys, project, body, file };
}

it.each(['plaintext', 'encrypted-looking'])('uses authoritative original bytes for %s files', async kind => {
	const h = await fixture();
	const body = kind === 'plaintext' ? h.body : (await sealFile({ path: h.file.path, content: new Uint8Array(h.body), contentType: 'text/markdown' }, h.keys.forPath(h.file.path))).bytes.buffer;
	const file = { ...h.file, hash: await sha256Hex(body), size: body.byteLength };
	const prepared = await prepareConversionFile(file, body, null, h.keys, h.project);
	const opened = await openFile(prepared.bytes, file.path, h.keys.forPath(file.path));
	expect(opened.content).toEqual(new Uint8Array(body));
	expect(prepared.plainHash).toBe(file.hash);
	expect(opened.metadata.contentType).toBe('application/octet-stream');
});

it('reuses the exact authenticated replacement after interruption', async () => {
	const h = await fixture();
	const first = await prepareConversionFile(h.file, h.body, 'text/markdown', h.keys, h.project);
	const replay = await prepareConversionFile(h.file, first.bytes.buffer, ENCRYPTED_FILE_CONTENT_TYPE, h.keys, h.project);
	expect(replay.bytes).toEqual(first.bytes);
	expect(replay.plainHash).toBe(h.file.hash);
});

it.each(['original corruption', 'replacement hash', 'replacement size', 'replacement content type', 'replacement corruption'] as const)('refuses %s before publication', async failure => {
	const h = await fixture();
	const sealed = await prepareConversionFile(h.file, h.body, 'text/markdown', h.keys, h.project);
	let body = sealed.bytes.buffer, contentType = ENCRYPTED_FILE_CONTENT_TYPE;
	if (failure === 'original corruption') { body = new TextEncoder().encode('Damaged original.').buffer; contentType = 'text/markdown'; }
	if (failure === 'replacement hash') h.file.hash = 'b'.repeat(64);
	if (failure === 'replacement size') h.file.size++;
	if (failure === 'replacement content type') contentType = 'text/plain';
	if (failure === 'replacement corruption') { const bytes = new Uint8Array(body.slice(0)); bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1; body = bytes.buffer; }
	await expect(prepareConversionFile(h.file, body, contentType, h.keys, h.project)).rejects.toThrow();
});

it('authenticates resumed bytes and rejects a different valid note', async () => {
	const h = await fixture('Reading/note.md');
	const prepared = await prepareConversionFile(h.file, h.body, 'text/markdown', h.keys, h.project);
	expect((await openFile(prepared.bytes, h.file.path, h.keys.forPath(h.file.path))).content).toEqual(new Uint8Array(h.body));
	expect(prepared.plainHash).toBe(h.file.hash);
	expect((await prepareConversionFile(h.file, prepared.bytes.buffer, ENCRYPTED_FILE_CONTENT_TYPE, h.keys, h.project)).bytes).toEqual(prepared.bytes);
	const unrelated = await sealFile({ path: h.file.path, content: new TextEncoder().encode('Different note.'), contentType: 'text/markdown' }, h.keys.forPath(h.file.path));
	await expect(prepareConversionFile(h.file, unrelated.bytes.buffer, ENCRYPTED_FILE_CONTENT_TYPE, h.keys, h.project)).rejects.toThrow('does not match');
});

it.each([
	{ kind: 'reminder' as const, response: { reminder: { filePath: 'Reminders/note.md', content: 'Private reminder' } } },
	{ kind: 'reminder' as const, response: { reminder: { filePath: null } } },
	{ kind: 'reminder' as const, response: { success: true } },
	{ kind: 'reading' as const, response: { id: 'reading-result' } },
	{ kind: 'upload' as const, response: { path: 'private.md', hash: 'private hash' } },
])('encrypts the $kind receipt with the vault key', async ({ kind, response }) => {
	const h = await fixture(), operationId = 'operation-id';
	const prepared = await prepareConversionReceipt({ operation_id: operationId, request_hash: 'request-hash', response_json: JSON.stringify(response) }, kind, h.keys);
	const expected = { ...(kind === 'upload' ? { kind } : {}), requestHash: 'request-hash', response };
	const context = { vaultId: h.bundle.vaultId, scopeId: 'vault', objectId: operationId, purpose: 'reminder' as const };
	expect(await decryptJson(prepared.vault, h.keys.forVaultMetadata().key, context)).toEqual(expected);
	expect(Object.keys(prepared).sort()).toEqual([...(kind === 'reminder' ? [] : ['kind']), 'operationId', 'vault'].sort());
	expect(prepared.kind).toBe(kind === 'reminder' ? undefined : kind);
	expect(prepared.vault).not.toContain('Private reminder');
});
