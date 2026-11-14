/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { createEncryptionFixture, storeEncryptionState } from '../test-support/encryption-test-harness';
import { handleSharedSettings } from './metadata-handlers';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { await reset(); });

const settings = { ignorePatterns: ['.git/'], syncInterval: 30, pushEnabled: false };
const put = (body: unknown) => handleSharedSettings(new Request('https://test/settings', { method: 'PUT', body: JSON.stringify(body) }), env.DB, null);
const read = async () => (await handleSharedSettings(new Request('https://test/settings'), env.DB, null)).json() as Promise<{ settings: unknown; settingsVersion: string | null }>;

it('stores plaintext settings in D1 and replaces only the version it was given', async () => {
	expect(await read()).toEqual({ settings: null, settingsVersion: null });
	expect((await put({ expectedVersion: null, settings: { ...settings, pushEnabled: 'false' } })).status).toBe(400);
	expect((await put({ expectedVersion: 7, settings })).status).toBe(400);
	const created = await put({ expectedVersion: null, settings });
	expect(created.status).toBe(200);
	const { settingsVersion } = await created.json() as { settingsVersion: string };
	expect(await read()).toEqual({ settings, settingsVersion });
	// A second first write and a stale version both lose to the stored settings.
	expect((await put({ expectedVersion: null, settings: { ...settings, ignorePatterns: ['other'] } })).status).toBe(409);
	const updated = await put({ expectedVersion: settingsVersion, settings: { ...settings, ignorePatterns: ['concurrent'] } });
	expect(updated.status).toBe(200);
	expect((await put({ expectedVersion: settingsVersion, settings })).status).toBe(409);
	expect((await read()).settings).toEqual({ ...settings, ignorePatterns: ['concurrent'] });
	expect((await env.BUCKET.list()).objects).toEqual([]);
});

it('refuses a plaintext write once the vault is encrypted', async () => {
	const { state } = await createEncryptionFixture('active');
	await storeEncryptionState(env.DB, state);
	expect((await put({ expectedVersion: null, settings })).status).toBe(409);
	expect(await env.DB.prepare('SELECT settings FROM server_state WHERE id = 1').first()).toEqual({ settings: null });
});
