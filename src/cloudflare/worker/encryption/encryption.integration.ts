/// <reference types="@cloudflare/vitest-plugin/types" />
import { commitStagedFile } from '../sync/mutations';
import { commitNewFiles } from '../sync/bulk-new-file-commit';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { createEncryptionFixture, storeEncryptionState } from '../test-support/encryption-test-harness';
import type { VaultKeyBundle } from '../../../encryption/key-bundle';
import { createReminderProjection } from '../../../encryption/reminder-projection';
import { sealFile } from '../../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../../encryption/file-format';
import { ENCRYPTION_FILE_PREFIX } from './state';
import { handleUpload } from '../sync/file-handlers';
import { getStoredFileRow } from '../sync/storage';
import { trackStagedUpload } from '../sync/staged-uploads';
import { uploadMutation } from '../sync/mutations';
import { handleNotificationPolicy } from '../notifications/policy';
import { drainNotificationProjections } from '../notifications/projection';
import { drainNotificationJobs } from '../notifications/outbox';
import { createReminderOperationId } from '../../../protocol/reminder-operation';
import { parseEncryptedNotification } from '../../../encryption/notification-format';
import { handleEncryptionRoute } from '../routes/encryption';
import worker from '../index';
import { createManagedObjectKey } from '../../../protocol/storage-keys';
import { sha256Hex } from '../../../platform/sha256';
import { sealFolderLabel } from '../../../encryption/folder-label';
import { importEncryptionSecret } from '../../../encryption/envelope';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function configure() {
	const fixture = await createEncryptionFixture('active');
	await storeEncryptionState(env.DB, fixture.state);
	return fixture;
}
const secrets = (bundle: VaultKeyBundle) => [bundle.vault.secret, bundle.notifications.secret, bundle.seal.privateKey];

it('atomically stores ciphertext, its descriptor and encrypted scheduling projections', async () => {
	const { bundle, state, keys, notifications, paths } = await configure();
	// The server stores the folder's tag and its sealed name, never the name itself.
	const folder = await sealFolderLabel('Reminders', paths, await importEncryptionSecret(bundle.vault), bundle.vaultId);
	const policy = await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST',
		body: JSON.stringify({ folderPath: folder.wire, folderLabel: folder.label, timezone: 'UTC', allDayTime: null }) }), env.DB);
	expect(policy.status, await policy.clone().text()).toBe(200);
	const plain = 'Reminders/Inbox.md', path = await paths.wire(plain);
	const text = '- [ ] Secret medical appointment 2099-01-02T10:00:00.000Z <!-- crate-id:r1 -->';
	const content = new TextEncoder().encode(text);
	const file = await sealFile({ path: plain, content, contentType: 'text/markdown', publicData: await createReminderProjection(notifications, ['Reminders'], plain, content.buffer) }, keys.forPath(path));
	const request = new Request(`https://test/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: file.bytes,
		headers: { 'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE, 'X-File-Hash': file.hash, 'X-File-Size': String(file.bytes.length),
			'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)) } });
	const result = await handleUpload(request, env.BUCKET, env.DB, { commitUpload: commitStagedFile, commitNewFiles });
	expect(result.status, await result.clone().text()).toBe(200);
	const stored = await getStoredFileRow(env.DB, path);
	expect(stored?.hash).toBe(file.hash);
	expect(await (await env.BUCKET.get(stored!.storageKey))!.text()).not.toContain('Secret medical');
	const descriptor = await env.DB.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(ENCRYPTION_FILE_PREFIX + stored!.storageKey).first<{ value: string }>();
	expect(JSON.parse(descriptor!.value)).toEqual(file.descriptor);
	await drainNotificationProjections(env);
	await drainNotificationJobs(env);
	const alarm = await env.DB.prepare('SELECT content FROM scheduled_reminders WHERE reminder_id = ?').bind('r1').first<{ content: string }>();
	expect(alarm?.content).not.toContain('Secret medical');
	expect(parseEncryptedNotification(alarm!.content)).toMatchObject({ vaultId: bundle.vaultId, reminderId: 'r1' });
	// Every session reads the same public configuration; none of it is secret.
	const scoped = await (await handleEncryptionRoute(new Request('https://test/encryption'), env.DB, '/encryption', { tokenId: 'web', scope: 'reminders', folderPath: folder.wire }))!.text();
	expect(JSON.parse(scoped)).toEqual({ encryption: state, folderPath: folder.wire, folderLabel: folder.label });
	for (const secret of secrets(bundle)) expect(scoped).not.toContain(secret);
});

it('rejects an in-flight plaintext publication whose SQL was prepared before encryption began', async () => {
	const hash = 'a'.repeat(64), path = 'late.md', key = createManagedObjectKey(hash);
	await trackStagedUpload(env.DB, key, path);
	const pending = uploadMutation(env.DB, { path, hash, size: 5, objectKey: key, expectedHash: null });
	await configure();
	await pending.run();
	expect(await getStoredFileRow(env.DB, path)).toBeNull();
	await expect(trackStagedUpload(env.DB, createManagedObjectKey(hash), 'new-plaintext.md')).rejects.toThrow('Encryption changed');
});

it('fences old clients and keeps scoped sessions away from vault secrets, history and sibling files', async () => {
	const { bundle, state } = await configure();
	for (const [id, scope, folder] of [['root', 'vault', null], ['web', 'reminders', 'Reminders']] as const) await env.DB.prepare('INSERT INTO auth_tokens(id, token_hash, scope, folder_path) VALUES (?, ?, ?, ?)').bind(id, await sha256Hex(id), scope, folder).run();
	const request = (path: string, token: string, encrypted = true, protocol = '1') => worker.fetch(new Request(`https://test${path}`, { headers: {
		Authorization: `Bearer ${token}`, 'X-Crate-Protocol': protocol, ...(encrypted ? { 'X-Crate-Encryption-Vault': bundle.vaultId, 'X-Crate-Encryption-Generation': String(bundle.generation) } : {}),
	} }), env);
	expect((await request('/sync/manifest', 'root', false)).status).toBe(428);
	expect((await request('/sync/manifest', 'root', true, '11')).status).toBe(428);
	expect((await request('/encryption/deletion-precondition?path=note.md&revision=revision', 'web')).status).toBe(403);
	expect((await request('/sync/versions', 'web')).status).toBe(403);
	expect((await request('/reminders/encrypted-files?folderPath=Private', 'web')).status).toBe(403);
	const publicState = await (await request('/encryption', 'web')).text();
	for (const secret of secrets(bundle)) expect(publicState).not.toContain(secret);
	expect(JSON.parse(publicState)).toEqual({ encryption: state });
	expect((await request('/encryption', 'invalid')).status).toBe(401);
	expect((await request('/sync/manifest', 'web')).status).toBe(403);
	expect((await request('/settings', 'web')).status).toBe(403);
	expect((await request('/reminders/encrypted-files?folderPath=Reminders', 'web')).status).toBe(200);
});
