import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVaultKeyBundle } from '../../encryption/key-bundle';
import { ENCRYPTION_VAULT_HEADER } from '../../encryption/server-state';
import { EncryptedFiles } from '../encryption/encrypted-files';
import { SyncApiClient } from './client';
import type { ApiHttpTransport } from './http';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function response(value: unknown) {
	const text = JSON.stringify(value);
	return { status: 200, text, arrayBuffer: new TextEncoder().encode(text).buffer, headers: {} };
}

it('stays unencrypted when a key fails to import after the file keys', async () => {
	const bundle = await createVaultKeyBundle();
	const vault = bundle.vault;
	let current = vault;
	Object.defineProperty(bundle, 'vault', { get: () => current });
	// The file keys import; the folder key read afterwards does not.
	const create = EncryptedFiles.create.bind(EncryptedFiles);
	vi.spyOn(EncryptedFiles, 'create').mockImplementation(async (...args) => {
		const files = await create(...args);
		current = { ...vault, secret: '' };
		return files;
	});
	const transport = vi.fn<ApiHttpTransport>(async () => response({ files: {} }));
	const client = new SyncApiClient('https://crate.example', 'token', transport);

	await expect(client.configureEncryption(bundle, () => [])).rejects.toThrow();

	expect(client.isEncrypted()).toBe(false);
	await client.getFileMetadata(['note.md']);
	const request = transport.mock.calls.at(-1)![0];
	expect(request.headers?.[ENCRYPTION_VAULT_HEADER]).toBeUndefined();
	expect(JSON.parse(request.body as string)).toEqual({ paths: ['note.md'] });
});
