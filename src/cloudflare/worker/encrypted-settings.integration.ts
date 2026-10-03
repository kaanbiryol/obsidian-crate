/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../encryption/key-bundle';
import { createEncryptionState } from '../../encryption/server-state';
import { decryptJson, encryptJson, importEncryptionSecret } from '../../encryption/envelope';
import { MAX_ENCRYPTED_SETTINGS_REQUEST_BYTES, MAX_SHARED_SETTINGS_BYTES } from '../../encryption/settings-format';
import { handleEncryptionConversion } from './encryption-conversion';
import { handleEncryptedSettings } from './encrypted-settings';
import { readEncryptionState } from './encryption-state';
import { handlePutSettings } from './sync-metadata-handlers';

beforeEach(async () => { for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { await reset(); });

const preferences = () => ({ ignorePatterns: ['秘密/'], syncOnStartup: true, syncOnResume: true, syncInterval: 30, showStatusBar: true, pushEnabled: false });
async function fixture() {
	const bundle = createVaultKeyBundle();
	const state = createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode()));
	const key = await importEncryptionSecret(bundle.vault);
	const context = { vaultId: bundle.vaultId, scopeId: 'vault', objectId: 'shared-settings', purpose: 'settings' as const };
	const control = (path: string, body: unknown) => handleEncryptionConversion(new Request(`https://test${path}`, { method: 'POST', body: JSON.stringify(body), headers: {
		'X-Crate-Encryption-Vault': bundle.vaultId, 'X-Crate-Encryption-Generation': String(bundle.generation),
	} }), env, path);
	return { bundle, state, key, context, control };
}

it.each([66_200, MAX_SHARED_SETTINGS_BYTES])('converts and updates settings accepted in a %i-byte plaintext request', async bytes => {
	const { bundle, state, key, context, control } = await fixture();
	const settings = preferences();
	const original = { settings, expectedVersion: null };
	settings.ignorePatterns[0] += 'x'.repeat(bytes - new TextEncoder().encode(JSON.stringify(original)).length);
	const plainBody = JSON.stringify(original);
	expect(new TextEncoder().encode(plainBody).length).toBe(bytes);
	expect((await handlePutSettings(new Request('https://test/settings', { method: 'PUT', body: plainBody }), env.BUCKET)).status).toBe(200);
	expect((await control('/encryption/conversion', state))?.status).toBe(200);
	const encrypted = { version: 1, vaultId: bundle.vaultId, keyId: key.id, envelope: await encryptJson(settings, key, context) };
	const converted = await handleEncryptionConversion(new Request('https://test/encryption/conversion/settings', {
		method: 'PUT', body: JSON.stringify(encrypted), headers: { 'X-Crate-Encryption-Vault': bundle.vaultId, 'X-Crate-Encryption-Generation': String(bundle.generation) },
	}), env, '/encryption/conversion/settings');
	expect(converted?.status, await converted?.clone().text()).toBe(200);
	expect((await control('/encryption/conversion/finish', {}))?.status).toBe(200);
	expect((await readEncryptionState(env.DB))?.mode).toBe('active');
	expect(await env.BUCKET.get('__crate__/settings.json')).toBeNull();
	const read = async () => (await handleEncryptedSettings(new Request('https://test/settings'), env.DB))!.json() as Promise<{ settings: typeof encrypted; settingsVersion: string }>;
	const saved = await read();
	await expect(decryptJson(saved.settings.envelope, key, context)).resolves.toEqual(settings);
	settings.syncInterval++;
	encrypted.envelope = await encryptJson(settings, key, context);
	const update = await handleEncryptedSettings(new Request('https://test/settings', { method: 'PUT', body: JSON.stringify({ settings: encrypted, expectedVersion: saved.settingsVersion }) }), env.DB);
	expect(update?.status, await update?.clone().text()).toBe(200);
	await expect(decryptJson((await read()).settings.envelope, key, context)).resolves.toEqual(settings);
	// The larger allowance remains bounded and a rejection preserves committed data.
	const oversized = await handleEncryptedSettings(new Request('https://test/settings', { method: 'PUT', body: JSON.stringify({ settings: { ...encrypted, envelope: 'a'.repeat(MAX_ENCRYPTED_SETTINGS_REQUEST_BYTES) }, expectedVersion: saved.settingsVersion }) }), env.DB);
	expect(oversized?.status).toBe(413);
	await expect(decryptJson((await read()).settings.envelope, key, context)).resolves.toEqual(settings);
});

it('rejects unsupported stored settings before freezing sync and permits retry after reducing them', async () => {
	const { state, control } = await fixture();
	const body = JSON.stringify(preferences()) + ' '.repeat(MAX_SHARED_SETTINGS_BYTES);
	await env.BUCKET.put('__crate__/settings.json', body);
	expect((await control('/encryption/conversion', state))?.status).toBe(413);
	expect(await readEncryptionState(env.DB)).toBeNull();
	expect(await (await env.BUCKET.get('__crate__/settings.json'))!.text()).toBe(body);
	const expectedVersion = (await env.BUCKET.head('__crate__/settings.json'))!.etag;
	expect((await handlePutSettings(new Request('https://test/settings', { method: 'PUT', body: JSON.stringify({ settings: preferences(), expectedVersion }) }), env.BUCKET)).status).toBe(200);
	expect((await control('/encryption/conversion', state))?.status).toBe(200);
});
