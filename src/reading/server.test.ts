import { beforeEach, expect, it, vi } from 'vitest';
import type CratePlugin from '../plugin/CratePlugin';
import { serverRequest } from '../plugin/server-request';
import { readReadingPolicy, writeReadingPolicy } from './server';

vi.mock('../plugin/server-request', async importOriginal => ({
	...await importOriginal<typeof import('../plugin/server-request')>(),
	serverRequest: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
let api: { localFolder: (path: string, label: string) => Promise<string>; serverFolder: (path: string) => Promise<{ folderPath: string; folderLabel?: string }> } | null = null;
const plugin = {
	settings: { workerUrl: 'https://server.example' },
	secretStorage: { get: () => 'token' },
	syncRuntime: { getApiClient: () => api },
} as unknown as CratePlugin;
const policy = { enabled: 1, folder_path: 'Reading', generation: 'g', revision: 'r' };
beforeEach(() => { api = null; });

it('reads a missing or saved Reading policy', async () => {
	vi.mocked(serverRequest).mockResolvedValueOnce({ policy: null }).mockResolvedValueOnce({ policy });
	await expect(readReadingPolicy(plugin)).resolves.toBeNull();
	await expect(readReadingPolicy(plugin)).resolves.toEqual(policy);
	expect(serverRequest).toHaveBeenCalledWith(plugin, '/reading/policy');
});

it('writes a Reading policy and returns the saved one', async () => {
	vi.mocked(serverRequest).mockResolvedValueOnce({ policy });
	const update = { enabled: true, folderPath: 'Reading', revision: null };
	await expect(writeReadingPolicy(plugin, update)).resolves.toEqual(policy);
	expect(serverRequest).toHaveBeenCalledWith(plugin, '/reading/policy', update);
});

it.each([{}, { policy: { ...policy, generation: undefined } }])('rejects a malformed policy response %j', async response => {
	vi.mocked(serverRequest).mockResolvedValue(response);
	await expect(readReadingPolicy(plugin)).rejects.toThrow('Could not read Reading settings.');
	await expect(writeReadingPolicy(plugin, { enabled: false, folderPath: 'Reading', revision: 'r' })).rejects.toThrow('Could not read Reading settings.');
});

it('rejects a write that returns no policy', async () => {
	vi.mocked(serverRequest).mockResolvedValue({ policy: null });
	await expect(writeReadingPolicy(plugin, { enabled: false, folderPath: 'Reading', revision: 'r' })).rejects.toThrow('Could not read Reading settings.');
});

it('maps an encrypted folder with the client of the connection that made the request', async () => {
	api = { localFolder: async () => 'Reading', serverFolder: async () => ({ folderPath: 'tag', folderLabel: 'label' }) };
	const encrypted = { ...policy, folder_path: 'tag', folder_label: 'label' };
	vi.mocked(serverRequest).mockResolvedValueOnce({ policy: encrypted });
	await expect(writeReadingPolicy(plugin, { enabled: true, folderPath: 'Reading', revision: null })).resolves.toEqual(policy);
	expect(serverRequest).toHaveBeenCalledWith(plugin, '/reading/policy', { enabled: true, folderPath: 'tag', folderLabel: 'label', revision: null });

	// A sync client replaced while the request ran holds another connection's keys.
	vi.mocked(serverRequest).mockImplementationOnce(async () => {
		api = { localFolder: async () => 'Other', serverFolder: async () => ({ folderPath: 'other' }) };
		return { policy: encrypted };
	});
	await expect(readReadingPolicy(plugin)).rejects.toMatchObject({ name: 'AbortError' });
});
