import { expect, it, vi } from 'vitest';
import { SyncWorkerApi } from './sync';
import { HttpError, type WorkerApiHttpClient } from './http';
import { EncryptedFiles } from '../encrypted-files';
import { createVaultKeyBundle } from '../../encryption/key-bundle';
import { BATCH_FILE_SIZE_LIMIT } from '../../protocol/sync-limits';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { arrayBufferToBase64 } from '../encoding';

it.each(['version_conflict', 'namespace_conflict'])('preserves per-file %s results when ciphertext outgrows a batch', async code => {
	const api = new SyncWorkerApi({} as WorkerApiHttpClient);
	api.setEncryption(await EncryptedFiles.create({} as WorkerApiHttpClient, createVaultKeyBundle(), async () => null));
	const upload = vi.spyOn(api, 'uploadFile').mockImplementation(async (path, _bytes, hash) => {
		if (path === 'stale.md') throw new HttpError('Remote file changed', 409, null, code);
		return { success: true, path, hash, revision: 'accepted' };
	});
	const bytes = new Uint8Array(BATCH_FILE_SIZE_LIMIT + 1);
	const files = ['stale.md', 'other.md'].map(path => ({ path, content: arrayBufferToBase64(bytes.buffer), hash: 'ciphertext-hash',
		size: bytes.byteLength, contentType: ENCRYPTED_FILE_CONTENT_TYPE, expectedHash: 'old-ciphertext-hash', operationId: 'saved-operation' }));
	await expect(api.batchUpload(files)).resolves.toMatchObject({ success: false, results: [
		{ path: 'stale.md', success: false, code, status: 409 }, { path: 'other.md', success: true },
	] });
	expect(upload).toHaveBeenCalledTimes(2);
	const failure = new HttpError('Service unavailable', 503, null);
	upload.mockRejectedValueOnce(failure);
	await expect(api.batchUpload(files)).rejects.toBe(failure);
});
