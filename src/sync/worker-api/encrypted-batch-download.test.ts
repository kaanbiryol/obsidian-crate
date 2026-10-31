import { expect, it, vi } from 'vitest';
import { SyncWorkerApi } from './sync';
import type { WorkerApiHttpClient } from './http';
import { EncryptedFiles } from '../encryption/encrypted-files';
import { createVaultKeyBundle } from '../../encryption/key-bundle';
import { sealFile } from '../../encryption/file-codec';
import { sealFileForVault } from '../../encryption/sealed-file';
import { createOpaqueWireName } from '../../protocol/encrypted-path';
import { arrayBufferToBase64 } from '../encoding';
import { sha256Hex } from '../../platform/sha256';

it('decrypts a batch with bounded overlap and returns verified bytes in order', async () => {
	const encryption = await EncryptedFiles.create({} as WorkerApiHttpClient, await createVaultKeyBundle(), async () => null);
	const paths = Array.from({ length: 10 }, (_, index) => `n/${index}.md`);
	// The server lists files by their tagged paths.
	const files = await Promise.all(paths.map(async path => {
		const sealed = await sealFile({ path, content: new TextEncoder().encode(`body ${path}`), contentType: 'text/markdown' }, encryption.keys.forPath(path));
		return { path: await encryption.paths.wireFor(path), content: arrayBufferToBase64(sealed.bytes.buffer), hash: sealed.hash, size: sealed.bytes.byteLength, contentType: 'application/octet-stream' };
	}));
	const api = new SyncWorkerApi({ requestJson: vi.fn(async () => ({ files })) } as unknown as WorkerApiHttpClient);
	api.setEncryption(encryption);
	let active = 0, peak = 0;
	const download = encryption.download.bind(encryption);
	vi.spyOn(encryption, 'download').mockImplementation(async (...args) => {
		active++; peak = Math.max(peak, active);
		try { return await download(...args); } finally { active--; }
	});
	const result = await api.batchDownload(paths);
	// Before: one file at a time, re-encoded to base64 for the caller to decode.
	expect(peak).toBeGreaterThan(1);
	expect(peak).toBeLessThanOrEqual(4);
	expect(result.files.map(file => file.path)).toEqual(paths);
	for (const file of result.files) {
		if (!('verifiedContent' in file)) throw new Error('Expected decrypted bytes');
		expect(new TextDecoder().decode(file.verifiedContent)).toBe(`body ${file.path}`);
		expect(file.hash).toBe(await sha256Hex(file.verifiedContent));
	}
});

it('reads the Reading folder\'s synced files once per batch of sealed notes', async () => {
	const bundle = await createVaultKeyBundle();
	const encryption = await EncryptedFiles.create({} as WorkerApiHttpClient, bundle, async () => null, () => 'Reading');
	const folder = await encryption.paths.wireFor('Reading');
	const recipient = { vaultId: bundle.vaultId, keyId: bundle.seal.id, publicKey: bundle.seal.publicKey };
	// Notes the server saved from the Shortcut, under random server names.
	const files = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
		const sealed = await sealFileForVault({ path: `${folder}/Article ${index}.md`, content: new TextEncoder().encode(`saved ${index}`), contentType: 'text/markdown' }, recipient);
		return { path: `${folder}/${createOpaqueWireName()}`, content: arrayBufferToBase64(sealed.bytes.buffer), hash: await sha256Hex(sealed.bytes), size: sealed.bytes.byteLength, contentType: 'application/octet-stream' };
	}));
	const api = new SyncWorkerApi({ requestJson: vi.fn(async () => ({ files })) } as unknown as WorkerApiHttpClient);
	api.setEncryption(encryption);
	const plain = files.map((_, index) => `Reading/Article ${index}.md`);
	// A metadata listing taught this device each note's server name.
	await Promise.all(files.map((file, index) => encryption.paths.learn(plain[index]!, file.path)));
	const syncedIn = vi.spyOn(encryption.paths, 'syncedIn');
	const result = await api.batchDownload(plain);
	expect(result.files.map(file => file.path)).toEqual(plain);
	// Before: every sealed note scanned the whole local manifest again.
	expect(syncedIn).toHaveBeenCalledOnce();
});
