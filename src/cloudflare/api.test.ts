import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as obsidian from 'obsidian';
import { buildCloudflareTokenTemplateUrl, listAccessibleAccounts, verifyToken } from './api';

describe('verifyToken', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns true for a valid token', async () => {
		vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({
			status: 200,
			json: { success: true, result: { status: 'active' } },
		} as never);

		await expect(verifyToken('valid-token')).resolves.toBe(true);
	});

	it('returns false for an invalid token', async () => {
		vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({
			status: 401,
			json: { success: false },
		} as never);

		await expect(verifyToken('bad-token')).resolves.toBe(false);
	});

	it('returns false on network error', async () => {
		vi.spyOn(obsidian, 'requestUrl').mockRejectedValue(new Error('network'));

		await expect(verifyToken('any')).resolves.toBe(false);
	});
});

describe('listAccessibleAccounts', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns accounts on success', async () => {
		vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({
			status: 200,
			json: {
				success: true,
				result: [
					{ id: 'acct-1', name: 'My Account' },
					{ id: 'acct-2', name: 'Team Account' },
				],
			},
		} as never);

		const accounts = await listAccessibleAccounts('token');
		expect(accounts).toEqual([
			{ id: 'acct-1', name: 'My Account' },
			{ id: 'acct-2', name: 'Team Account' },
		]);
	});

	it('returns a single account', async () => {
		vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({
			status: 200,
			json: {
				success: true,
				result: [{ id: 'acct-1', name: 'Solo Account' }],
			},
		} as never);

		const accounts = await listAccessibleAccounts('token');
		expect(accounts).toEqual([{ id: 'acct-1', name: 'Solo Account' }]);
	});

	it('throws on API error', async () => {
		vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({
			status: 403,
			json: { success: false, errors: [{ message: 'Forbidden' }] },
		} as never);

		await expect(listAccessibleAccounts('bad')).rejects.toThrow('Forbidden');
	});

	it('returns empty array when no accounts', async () => {
		vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({
			status: 200,
			json: { success: true, result: [] },
		} as never);

		const accounts = await listAccessibleAccounts('token');
		expect(accounts).toEqual([]);
	});
});

describe('buildCloudflareTokenTemplateUrl', () => {
	it('returns a Cloudflare dashboard URL', () => {
		const url = buildCloudflareTokenTemplateUrl();
		expect(url).toContain('dash.cloudflare.com/profile/api-tokens');
	});
});
