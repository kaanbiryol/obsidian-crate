/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { createVaultKeyBundle, addReminderScope, generateRecoveryCode, sealRecoveryBundle } from '../../encryption/key-bundle';
import { createEncryptionState } from '../../encryption/server-state';
import { FileKeyAuthority } from '../../encryption/file-authority';
import { createReminderProjection } from '../../encryption/reminder-projection';
import { sealFile } from '../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { ENCRYPTION_STATE_KEY, ENCRYPTION_FILE_PREFIX } from './encryption-state';
import { handleUpload } from './sync-file-handlers';
import { getStoredFileRow, createManagedObjectKey } from './sync-storage';
import { trackStagedUpload } from './staged-uploads';
import { uploadMutation } from './sync-mutations';
import { handleNotificationPolicy } from './notification-policy';
import { drainNotificationProjections } from './notification-projection';
import { drainNotificationJobs } from './notification-outbox';
import { createReminderOperationId } from '../../protocol/reminder-operation';
import { parseEncryptedNotification } from '../../encryption/notification-format';
import { handleEncryptionRoute } from './routes/encryption';
import { handleEncryptionConversion } from './encryption-conversion';
import { sha256Hex } from './auth';
import { encryptJson } from '../../encryption/envelope';
import { openFile } from '../../encryption/file-codec';
import { readEncryptionState } from './encryption-state';
import { handleCheckChanges } from './sync-metadata-handlers';
import worker from './index';

beforeEach(async () => { for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function configure() {
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const state = createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode()));
	state.mode = 'active';
	await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(ENCRYPTION_STATE_KEY, JSON.stringify(state)).run();
	return { bundle, state, keys: await FileKeyAuthority.fromVault(bundle) };
}

it('atomically stores ciphertext, its descriptor and encrypted scheduling projections', async () => {
	const { bundle, keys } = await configure();
	await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: null }) }), env.DB);
	const path = 'Reminders/Inbox.md';
	const text = '- [ ] Secret medical appointment 2099-01-02T10:00:00.000Z <!-- crate-id:r1 -->';
	const content = new TextEncoder().encode(text);
	const file = await sealFile({ path, content, contentType: 'text/markdown', publicData: await createReminderProjection(bundle, path, content.buffer) }, keys.forPath(path));
	const request = new Request(`https://test/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: file.bytes,
		headers: { 'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE, 'X-File-Hash': file.hash, 'X-File-Size': String(file.bytes.length),
			'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)) } });
	const result = await handleUpload(request, env.BUCKET, env.DB);
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
	const scoped = await handleEncryptionRoute(new Request('https://test/encryption'), env.DB, '/encryption', { tokenId: 'web', scope: 'reminders', folderPath: 'Reminders' });
	expect(await scoped!.json()).toMatchObject({ encryption: { scope: { id: bundle.scopes[0]!.id } } });
	expect(await (await handleEncryptionRoute(new Request('https://test/encryption'), env.DB, '/encryption', { tokenId: 'web', scope: 'reminders', folderPath: 'Reminders' }))!.text()).not.toContain(bundle.vault.secret);
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

it('keeps the next change visible after converting an empty vault', async () => {
	const { state } = await configure();
	await env.DB.prepare('UPDATE maintenance_state SET value = ? WHERE key = ?').bind(JSON.stringify({ ...state, mode: 'converting' }), ENCRYPTION_STATE_KEY).run();
	await env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES ('e2ee:settings-converted', 'true')").run();
	const response = await handleEncryptionConversion(new Request('https://test/encryption/conversion/finish', { method: 'POST', headers: {
		'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation),
	} }), env, '/encryption/conversion/finish');
	expect(response?.status).toBe(200);
	const floor = (await env.DB.prepare('SELECT snapshot_seq FROM initial_import').first<{ snapshot_seq: number }>())!.snapshot_seq;
	await env.DB.prepare("INSERT INTO changelog(path, action, revision, hash, size) VALUES ('new.md', 'put', 'new', 'hash', 1)").run();
	const sequence = (await env.DB.prepare('SELECT MAX(seq) AS seq FROM changelog').first<{ seq: number }>())!.seq;
	expect(sequence).toBeGreaterThan(floor);
	expect(await (await handleCheckChanges(new Request(`https://test/sync/check?since=${floor}`), env.DB)).json()).toMatchObject({ hasChanges: true });
});

it('resumes an R2 replacement before D1 reconciliation and protects retained history before activation', async () => {
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const keys = await FileKeyAuthority.fromVault(bundle);
	const state = createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode()));
	const path = 'Reminders/Inbox.md', plain = '- [ ] Conversion secret 2099-01-02 <!-- crate-id:r1 -->';
	for (const [revision, content, current] of [['current-version', plain, true], ['old-version', plain + '\nOld private paragraph', false]] as const) {
		await env.BUCKET.put(revision, content, { httpMetadata: { contentType: 'text/markdown' } });
		const hash = await sha256Hex(content), size = new TextEncoder().encode(content).length;
		if (current) await env.DB.prepare('INSERT INTO files(path, portable_path, hash, size, storage_key) VALUES (?, ?, ?, ?, ?)').bind(path, path.toLowerCase(), hash, size, revision).run();
		else await env.DB.prepare("INSERT INTO file_versions(storage_key, path, hash, size, reason, expires_at) VALUES (?, ?, ?, ?, 'replaced', ?)").bind(revision, path, hash, size, Date.now() + 86400000).run();
	}
	await env.BUCKET.put('__crate__/files/orphan', 'orphan plaintext');
	await env.DB.prepare("INSERT INTO changelog(path, action, revision, hash, size) VALUES (?, 'put', 'current-version', ?, ?)").bind(path, await sha256Hex(plain), plain.length).run();
	const headers = { 'X-Crate-Encryption-Vault': bundle.vaultId, 'X-Crate-Encryption-Generation': String(bundle.generation) };
	const control = (path: string, method = 'GET', body?: string | Uint8Array<ArrayBuffer>) => handleEncryptionConversion(new Request(`https://test${path}`, { method, headers, body }), env, path.split('?')[0]!);
	expect((await control('/encryption/conversion', 'POST', JSON.stringify(state)))?.status).toBe(200);
	expect((await control('/encryption/conversion/finish', 'POST', '{}'))?.status).toBe(409);
	for (const [revision, original] of [['current-version', plain], ['old-version', plain + '\nOld private paragraph']]) {
		const content = new TextEncoder().encode(original);
		const sealed = await sealFile({ path, content, contentType: 'text/markdown', publicData: await createReminderProjection(bundle, path, content.buffer) }, keys.forPath(path));
		// Simulate process death after replacing the R2 object, before publishing
		// the descriptor/hash. Resume must retain those exact first ciphertext bytes.
		await env.BUCKET.put(revision!, sealed.bytes, { httpMetadata: { contentType: ENCRYPTED_FILE_CONTENT_TYPE }, customMetadata: { hash: sealed.hash } });
		const fresh = await sealFile({ path, content, contentType: 'text/markdown', publicData: await createReminderProjection(bundle, path, content.buffer) }, keys.forPath(path));
		const response = await control(`/encryption/conversion/file?revision=${revision}`, 'PUT', fresh.bytes);
		expect(response?.status, await response?.clone().text()).toBe(200);
		expect(await response!.json()).toMatchObject({ hash: sealed.hash });
		expect(await (await env.BUCKET.get(revision!))!.arrayBuffer()).toEqual(sealed.bytes.buffer);
	}
	const settings = { version: 1, vaultId: bundle.vaultId, keyId: bundle.vault.id, envelope: await encryptJson(null, keys.forVaultMetadata().key, { vaultId: bundle.vaultId, scopeId: 'vault', objectId: 'shared-settings', purpose: 'settings' }) };
	expect((await control('/encryption/conversion/settings', 'PUT', JSON.stringify(settings)))?.status).toBe(200);
	const finished = await control('/encryption/conversion/finish', 'POST', '{}');
	expect(finished?.status, await finished?.clone().text()).toBe(200);
	expect((await readEncryptionState(env.DB))?.mode).toBe('active');
	expect(await env.BUCKET.get('__crate__/files/orphan')).toBeNull();
	expect(await (await control('/encryption/conversion/finish', 'POST', '{}'))!.json()).toMatchObject({ encryption: { mode: 'active' } });
	const old = await env.BUCKET.get('old-version');
	expect(new TextDecoder().decode((await openFile(new Uint8Array(await old!.arrayBuffer()), path, keys.forPath(path))).content)).toContain('Old private paragraph');
	expect(await (await handleCheckChanges(new Request('https://test/sync/check?since=1'), env.DB)).json()).toMatchObject({ cursorExpired: true });
});

it('fences old clients and keeps scoped sessions away from vault keys, history and sibling files', async () => {
	const { bundle, state } = await configure();
	for (const [id, scope, folder] of [['root', 'vault', null], ['web', 'reminders', 'Reminders']] as const) await env.DB.prepare('INSERT INTO auth_tokens(id, token_hash, scope, folder_path) VALUES (?, ?, ?, ?)').bind(id, await sha256Hex(id), scope, folder).run();
	const request = (path: string, token: string, encrypted = true, protocol = '2') => worker.fetch(new Request(`https://test${path}`, { headers: {
		Authorization: `Bearer ${token}`, 'X-Crate-Protocol': protocol, ...(encrypted ? { 'X-Crate-Encryption-Vault': bundle.vaultId, 'X-Crate-Encryption-Generation': String(bundle.generation) } : {}),
	} }), env);
	expect((await request('/sync/manifest', 'root', false)).status).toBe(428);
	expect((await request('/sync/manifest', 'root', true, '11')).status).toBe(428);
	expect((await request('/encryption/conversion', 'web')).status).toBe(403);
	expect((await request('/sync/versions', 'web')).status).toBe(403);
	expect((await request('/reminders/encrypted-files?folderPath=Private', 'web')).status).toBe(403);
	const publicScope = await (await request('/encryption', 'web')).text();
	expect(publicScope).not.toContain(bundle.vault.id); expect(publicScope).not.toContain(bundle.vault.secret);
	expect(JSON.parse(publicScope)).toMatchObject({ encryption: { recovery: state.recovery } });
	expect((await request('/encryption', 'invalid')).status).toBe(401);
	expect((await request('/sync/manifest', 'web')).status).toBe(403);
	expect((await request('/settings', 'web')).status).toBe(403);
	expect((await request('/reminders/encrypted-files?folderPath=Reminders', 'web')).status).toBe(200);
});

it('sweeps full conversion pages within the query budget and preserves live and retained objects', async () => {
	const { state, keys } = await configure();
	await env.DB.prepare('UPDATE maintenance_state SET value = ? WHERE key = ?').bind(JSON.stringify({ ...state, mode: 'converting' }), ENCRYPTION_STATE_KEY).run();
	await env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES ('e2ee:settings-converted', 'true')").run();
	const retained = ['__crate__/files/current', '__crate__/files/history'];
	for (const [index, key] of retained.entries()) {
		const file = await sealFile({ path: 'note.bin', content: new Uint8Array([index]), contentType: 'application/octet-stream', publicData: null }, keys.forPath('note.bin'));
		await env.BUCKET.put(key, file.bytes);
		await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(ENCRYPTION_FILE_PREFIX + key, JSON.stringify(file.descriptor)).run();
		if (index === 0) await env.DB.prepare("INSERT INTO files(path, portable_path, hash, size, storage_key) VALUES ('note.bin', 'note.bin', ?, ?, ?)").bind(file.hash, file.bytes.length, key).run();
		else await env.DB.prepare("INSERT INTO file_versions(storage_key, path, hash, size, reason, expires_at) VALUES (?, 'note.bin', ?, ?, 'replaced', ?)").bind(key, file.hash, file.bytes.length, Date.now() + 86400000).run();
	}
	for (let index = 0; index < 225; index++) await env.BUCKET.put(`__crate__/files/orphan-${String(index).padStart(3, '0')}`, 'old plaintext');
	const prepare = vi.spyOn(env.DB, 'prepare');
	let pages = 0;
	for (; pages < 4; pages++) {
		prepare.mockClear();
		const response = await handleEncryptionConversion(new Request('https://test/encryption/conversion/finish', { method: 'POST', headers: {
			'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation),
		} }), env, '/encryption/conversion/finish');
		expect(response?.status).toBe(200);
		expect(prepare.mock.calls.length).toBeLessThanOrEqual(46);
		const result = await response!.json() as { pending?: boolean; encryption?: { mode: string } };
		if (!result.pending) { expect(result.encryption?.mode).toBe('active'); break; }
	}
	expect(pages).toBe(2);
	expect((await env.BUCKET.list()).objects.map(object => object.key)).toEqual(retained);
	expect((await readEncryptionState(env.DB))?.mode).toBe('active');
});
