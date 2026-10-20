import { beforeEach, expect, it, vi } from 'vitest';
import type CratePlugin from '../plugin/CratePlugin';
import { serverRequest } from '../plugin/server-request';
import { readReadingPolicy, writeReadingPolicy } from './server';

vi.mock('../plugin/server-request', () => ({ serverRequest: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const plugin = {} as CratePlugin;
const policy = { enabled: 1, folder_path: 'Reading', generation: 'g', revision: 'r' };

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
