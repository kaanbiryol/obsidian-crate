import { expect, it, vi } from 'vitest';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '../cloudflare/worker/sync-engine-vault-test-harness';
import { LocalManifest } from './manifest';
import { DurableUploads } from './durable-uploads';
import { EncryptedFiles } from './encrypted-files';
import { createVaultKeyBundle } from '../encryption/key-bundle';
import { arrayBufferToBase64 } from './encoding';
import { computeHash } from './hasher';
import type { WorkerApiHttpClient } from './worker-api/http';
import type { JournalUpload } from './upload-intent';

async function fixture() {
	const disk = new PersistentTestVault();
	const create = () => new LocalManifest({ vault: disk.vault } as never, { dir: TEST_PLUGIN_DIR } as never, 'https://server.test');
	const content = new TextEncoder().encode('Private content').buffer;
	const file = { path: 'note.md', content: arrayBufferToBase64(content), hash: await computeHash(content), size: content.byteLength,
		contentType: 'text/markdown', expectedHash: null };
	const encryption = await EncryptedFiles.create({} as WorkerApiHttpClient, createVaultKeyBundle(), async () => null);
	return { disk, create, file, encryption };
}

it('replays identical ciphertext and operation identity after a lost response and restart', async () => {
	const { create, file, encryption } = await fixture();
	const prepare = vi.fn((file: JournalUpload) => encryption.prepare(file));
	const sent: Array<[string, string, string | undefined]> = [];
	let loseResponse = true;
	const transport = {
		getServerInfo: async () => ({ reminderOperationDay: 20000 }), prepareUploadWire: prepare,
		assertPreparedUpload: (file: JournalUpload) => encryption.verifyPrepared(file),
		batchUpload: vi.fn(),
		uploadFile: async (path: string, body: ArrayBuffer, hash: string, _size: number, _type: string, _expected: string | null, id?: string) => {
			sent.push([arrayBufferToBase64(body), hash, id]);
			if (loseResponse) throw new Error('Lost response after commit');
			return { success: true, path, hash, revision: 'immutable-revision' };
		},
	};
	const cache = { putBase: vi.fn(async () => {}) };
	const first = create();
	await expect(new DurableUploads(first, transport, cache as never, crypto.randomUUID()).single(file)).rejects.toThrow('Lost response');
	await first.close();
	const restarted = create(); await restarted.load();
	loseResponse = false;
	await new DurableUploads(restarted, transport, cache as never, crypto.randomUUID()).recover();
	expect(prepare).toHaveBeenCalledOnce();
	expect(sent).toHaveLength(2);
	expect(sent[0]).toEqual(sent[1]);
	expect(sent[0]![1]).not.toBe(file.hash);
	expect(restarted.getEntry(file.path)?.hash).toBe(file.hash);
	expect(restarted.uploadJournal.pending()).toEqual([]);
	await restarted.close();
});

it('does not dispatch when persisting the encrypted wire fails', async () => {
	const { disk, create, file, encryption } = await fixture();
	const manifest = create();
	vi.spyOn(disk.vault.adapter, 'write').mockRejectedValue(new Error('Disk full'));
	const uploadFile = vi.fn();
	await expect(new DurableUploads(manifest, {
		getServerInfo: async () => ({ reminderOperationDay: 20000 }), prepareUploadWire: file => encryption.prepare(file),
		uploadFile, batchUpload: vi.fn(),
	}, { putBase: vi.fn() } as never, crypto.randomUUID()).single(file)).rejects.toThrow('Disk full');
	expect(uploadFile).not.toHaveBeenCalled();
	await manifest.close();
});

it('settles a saved plaintext upload from its converted receipt without retransmitting plaintext', async () => {
	const { create, file } = await fixture();
	const manifest = create();
	await manifest.uploadJournal.prepare([{ ...file, intent: { kind: 'local' } }], 20000, crypto.randomUUID());
	const uploadFile = vi.fn(), batchUpload = vi.fn(), cache = { putBase: vi.fn(async () => {}) };
	await new DurableUploads(manifest, { getServerInfo: async () => ({ reminderOperationDay: 20000 }),
		resolveLegacyUpload: async () => ({ success: true, path: file.path, hash: file.hash, revision: 'old-accepted-revision' }),
		assertPreparedUpload: async () => { throw new Error('Plaintext must not be dispatched'); }, uploadFile, batchUpload,
	}, cache as never, crypto.randomUUID()).recover();
	expect(uploadFile).not.toHaveBeenCalled(); expect(batchUpload).not.toHaveBeenCalled();
	expect(manifest.getEntry(file.path)).toMatchObject({ hash: file.hash, revision: 'old-accepted-revision' });
	expect(manifest.uploadJournal.pending()).toEqual([]);
	await manifest.close();
});

it('preserves a legacy upload when encryption cannot establish its old outcome', async () => {
	const { create, file } = await fixture();
	const manifest = create();
	await manifest.uploadJournal.prepare([{ ...file, intent: { kind: 'local' } }], 20000, crypto.randomUUID());
	const uploadFile = vi.fn();
	await expect(new DurableUploads(manifest, { getServerInfo: async () => ({ reminderOperationDay: 20000 }),
		resolveLegacyUpload: async () => { throw new Error('Old receipt expired'); }, uploadFile, batchUpload: vi.fn(),
	}, { putBase: vi.fn() } as never, crypto.randomUUID()).recover()).rejects.toThrow('Old receipt expired');
	expect(uploadFile).not.toHaveBeenCalled(); expect(manifest.uploadJournal.pending()).toHaveLength(1);
	await manifest.close();
});
