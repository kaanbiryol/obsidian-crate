/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { createEncryptionFixture, storeEncryptionState } from '../test-support/encryption-test-harness';
import { decryptJson, encryptJson } from '../../../encryption/envelope';
import { MAX_ENCRYPTED_SETTINGS_REQUEST_BYTES, MAX_SHARED_SETTINGS_BYTES } from '../../../encryption/settings-format';
import { handleEncryptedSettings } from './settings';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { await reset(); });

const preferences = () => ({ ignorePatterns: ['秘密/'], syncInterval: 30, pushEnabled: false });

it.each([66_200, MAX_SHARED_SETTINGS_BYTES])('stores and updates encrypted settings accepted in a %i-byte plaintext request', async bytes => {
	const { bundle, state, keys } = await createEncryptionFixture('active');
	await storeEncryptionState(env.DB, state);
	const key = keys.forVaultMetadata().key;
	const context = { vaultId: bundle.vaultId, scopeId: 'vault', objectId: 'shared-settings', purpose: 'settings' as const };
	const settings = preferences();
	const original = { settings, expectedVersion: null };
	settings.ignorePatterns[0] += 'x'.repeat(bytes - new TextEncoder().encode(JSON.stringify(original)).length);
	expect(new TextEncoder().encode(JSON.stringify(original)).length).toBe(bytes);
	const encrypted = { version: 1, vaultId: bundle.vaultId, keyId: key.id, envelope: await encryptJson(settings, key, context) };
	const put = (expectedVersion: string | null, value = encrypted) => handleEncryptedSettings(new Request('https://test/settings', {
		method: 'PUT', body: JSON.stringify({ settings: value, expectedVersion }) }), env.DB, state);
	const read = async () => (await handleEncryptedSettings(new Request('https://test/settings'), env.DB, state)).json() as Promise<{ settings: typeof encrypted; settingsVersion: string }>;
	// Settings at the plaintext limit still fit once encrypted.
	const created = await put(null);
	expect(created.status, await created.clone().text()).toBe(200);
	const saved = await read();
	await expect(decryptJson(saved.settings.envelope, key, context)).resolves.toEqual(settings);
	settings.syncInterval++;
	encrypted.envelope = await encryptJson(settings, key, context);
	const update = await put(saved.settingsVersion);
	expect(update.status, await update.clone().text()).toBe(200);
	await expect(decryptJson((await read()).settings.envelope, key, context)).resolves.toEqual(settings);
	// The larger allowance remains bounded and a rejection preserves committed data.
	const oversized = await put(saved.settingsVersion, { ...encrypted, envelope: 'a'.repeat(MAX_ENCRYPTED_SETTINGS_REQUEST_BYTES) });
	expect(oversized.status).toBe(413);
	await expect(decryptJson((await read()).settings.envelope, key, context)).resolves.toEqual(settings);
});
