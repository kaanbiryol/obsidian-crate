import { expect, it, vi } from 'vitest';
import { createVaultKeyBundle } from '../../encryption/key-bundle';
import { EncryptedFiles } from '../encrypted-files';
import type { WorkerApiHttpClient } from './http';
import { SharedSettingsWorkerApi } from './shared-settings';

const settings = { ignorePatterns: [], syncOnStartup: true, syncOnResume: true, syncInterval: 30, showStatusBar: true, pushEnabled: false };

async function fixture(value: unknown) {
	const requestJson = vi.fn<(path: string, request?: { method: string; body: string }) => Promise<unknown>>();
	const http = { requestJson } as unknown as WorkerApiHttpClient;
	const encryption = await EncryptedFiles.create(http, createVaultKeyBundle(), async () => null);
	const api = new SharedSettingsWorkerApi(http);
	api.setEncryption(encryption);
	const initial = { settings: await encryption.sealSettings(value), settingsVersion: 'converted' };
	requestJson.mockResolvedValue(initial);
	return { api, encryption, requestJson, initial };
}

it('reads an encrypted absence of shared settings after conversion', async () => {
	const { api } = await fixture(null);
	await expect(api.getSharedSettings()).resolves.toEqual({ settings: null, settingsVersion: 'converted' });
});

it('writes the first settings over a converted null with its ciphertext version precondition', async () => {
	const { api, encryption, requestJson, initial } = await fixture(null);
	requestJson.mockResolvedValueOnce(initial).mockResolvedValueOnce({ success: true, settingsVersion: 'saved' });
	await expect(api.putSharedSettings(settings)).resolves.toEqual({ success: true, settingsVersion: 'saved' });
	expect(requestJson).toHaveBeenCalledTimes(2);
	const [path, request] = requestJson.mock.calls[1]!;
	if (!request) throw new Error('Expected a settings write');
	expect(path).toBe('/settings'); expect(request.method).toBe('PUT');
	const body = JSON.parse(request.body) as { settings: unknown; expectedVersion: string };
	expect(body.expectedVersion).toBe('converted');
	await expect(encryption.openSettings(body.settings)).resolves.toEqual(settings);
});

it.each([false, [], {}, { ...settings, syncInterval: -1 }])('preserves invalid encrypted settings across repeated write attempts: %j', async value => {
	const { api, requestJson } = await fixture(value);
	await expect(api.putSharedSettings(settings)).rejects.toThrow('Decrypted shared settings are invalid');
	await expect(api.putSharedSettings(settings)).rejects.toThrow('Decrypted shared settings are invalid');
	expect(requestJson.mock.calls).toEqual([['/settings'], ['/settings']]);
});

it('still reads populated encrypted shared settings', async () => {
	const { api } = await fixture(settings);
	await expect(api.getSharedSettings()).resolves.toEqual({ settings, settingsVersion: 'converted' });
});
