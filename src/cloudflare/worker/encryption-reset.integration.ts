/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../encryption/key-bundle';
import { createEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import { readEncryptionState } from './encryption-state';
import { sha256Hex } from './auth';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';
import { handleUpload } from './sync-file-handlers';
import { getStoredFileRow } from './sync-storage';
import { FileKeyAuthority } from '../../encryption/file-authority';
import { sealFile } from '../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { createReminderOperationId } from '../../protocol/reminder-operation';
import { SYNC_RESET_GENERATION_KEY } from './sync-reset-generation';

const id = 'reset-operation', nextToken = 'b'.repeat(64);
let state: EncryptionServerState;
beforeEach(async () => {
	for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	const bundle = createVaultKeyBundle();
	state = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode())), mode: 'active' };
	await env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES ('e2ee:state', ?)").bind(JSON.stringify(state)).run();
	for (const [token, scope] of [['original', 'vault'], ['other', 'vault'], ['web', 'reminders']]) {
		await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope, folder_path) VALUES (?, ?, ?, 'Reminders')").bind(token!, await sha256Hex(token!), scope!).run();
	}
});
afterEach(async () => { await reset(); });

const request = (path: string, token: string, method = 'GET', body?: unknown) => worker.fetch(new Request(`https://test${path}`, {
	method, body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${token}`,
		'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), 'X-Crate-Encryption-Vault': state.vaultId,
		'X-Crate-Encryption-Generation': String(state.generation) },
}), env);
const start = () => request(`/encryption/reset?id=${id}`, 'original', 'POST', { confirmation: 'delete-remote-data', replacementToken: nextToken });
async function finish() {
	for (let pass = 0; pass < 30; pass++) {
		const response = await request(`/encryption/reset?id=${id}`, nextToken, 'POST', {});
		expect(response.status, await response.clone().text()).toBe(200);
		if ((await response.json() as { complete: boolean }).complete) return;
	}
	throw new Error('Reset did not finish');
}

it('requires vault authority, the current encryption identity and explicit destructive confirmation', async () => {
	expect((await request(`/encryption/reset?id=${id}`, 'web', 'POST', {})).status).toBe(403);
	expect((await request(`/encryption/reset?id=${id}`, 'original', 'POST', {})).status).toBe(400);
	const previous = state;
	state = { ...state, vaultId: 'different-vault' };
	expect((await start()).status).toBe(428);
	state = previous;
	expect((await readEncryptionState(env.DB))?.mode).toBe('active');
	expect((await request('/health', 'original')).status).toBe(200);
});

it('resumes bounded deletion, revokes old devices and grants, and never repeats a completed wipe', async () => {
	const readingTables = ['reading_policy', 'reading_sources', 'reading_jobs', 'reading_operations', 'reading_enrollments', 'reading_handoffs', 'reading_captures'];
	await env.DB.batch([
		env.DB.prepare("INSERT INTO reading_policy VALUES (1,1,'Reading','reading-generation','revision')"),
		env.DB.prepare("INSERT INTO reading_sources(path,revision,generation,metadata_json) VALUES ('Reading/private.md','r','reading-generation','private metadata')"),
		env.DB.prepare("INSERT INTO reading_jobs(path,item_id,generation,source_revision,block_hash,url,available_at) VALUES ('Reading/private.md','article','reading-generation','r','hash','https://private.example',0)"),
		env.DB.prepare("INSERT INTO reading_operations VALUES ('operation','original','reading-generation','hash','{}',1)"),
		env.DB.prepare("INSERT INTO reading_enrollments VALUES (?,'reading-generation','reading',9999999999999)").bind(await sha256Hex('old-reading-grant')),
		env.DB.prepare("INSERT INTO reading_handoffs VALUES ('handoff','original','reading-generation','private url',9999999999999)"),
		env.DB.prepare("INSERT INTO reading_captures(id,generation,url_identity,note,available_at) VALUES ('capture','reading-generation','private url','private note',0)"),
	]);
	await env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES ('crate_deployment_fence', 'infrastructure'), ('e2ee:settings', 'private'), ('reminder_source_scan_cursor', 'old')").run();
	await env.DB.prepare("INSERT INTO files(path, portable_path, hash, size, storage_key) VALUES ('remote-only.md', 'remote-only.md', 'hash', 1, 'current')").run();
	await env.DB.prepare("INSERT INTO file_versions(storage_key, path, hash, size, reason, expires_at) VALUES ('old', 'remote-only.md', 'hash', 1, 'replaced', 9999999999999)").run();
	await env.DB.prepare("INSERT INTO web_enrollment_tokens(token_hash, expires_at) VALUES ('grant', 9999999999999)").run();
	await env.DB.prepare("INSERT INTO push_subscriptions(id, owner_token_id, endpoint, p256dh, auth) VALUES ('push', 'web', 'https://push.test', 'key', 'auth')").run();
	await env.DB.prepare("INSERT INTO staged_uploads(storage_key, expires_at) VALUES ('late-object', 9999999999999)").run();
	for (let index = 0; index < 14; index++) await env.DB.prepare("INSERT INTO scheduled_reminders(reminder_id, schedule_token, content, due_datetime) VALUES (?, 'schedule', 'encrypted', '2099-01-01T00:00:00.000Z')").bind(`alarm-${index}`).run();
	for (let index = 0; index < 205; index++) await env.BUCKET.put(`object-${index}`, 'old encrypted bytes');
	const begin = await start();
	expect(begin.status, await begin.clone().text()).toBe(200);
	expect((await readEncryptionState(env.DB))?.mode).toBe('resetting');
	for (const table of readingTables) expect(await env.DB.prepare(`SELECT 1 FROM ${table}`).first()).toBeNull();
	expect(await env.DB.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(SYNC_RESET_GENERATION_KEY).first()).toEqual({ value: id });
	for (const token of ['original', 'other', 'web']) expect((await request('/health', token)).status).toBe(401);
	for (const path of ['/sync/manifest', '/encryption/conversion', '/auth/tokens']) expect((await request(path, nextToken)).status).toBe(423);
	expect((await request(`/encryption/reset?id=${id}`, nextToken)).status).toBe(200);
	expect(await env.DB.prepare('SELECT 1 FROM web_enrollment_tokens UNION SELECT 1 FROM push_subscriptions').first()).toBeNull();
	await finish();
	for (const table of readingTables) expect(await env.DB.prepare(`SELECT 1 FROM ${table}`).first()).toBeNull();
	expect((await request('/reading/exchange', nextToken, 'POST', { token: 'old-reading-grant' })).status).not.toBe(200);
	expect(await readEncryptionState(env.DB)).toBeNull();
	expect(await env.DB.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(SYNC_RESET_GENERATION_KEY).first()).toEqual({ value: id });
	expect((await env.BUCKET.list()).objects).toHaveLength(0);
	for (const table of ['files', 'file_versions', 'scheduled_reminders', 'notification_jobs']) expect(await env.DB.prepare(`SELECT 1 FROM ${table}`).first()).toBeNull();
	expect(await env.DB.prepare("SELECT state FROM staged_uploads WHERE storage_key = 'late-object'").first()).toEqual({ state: 'deleting' });
	expect(await env.DB.prepare("SELECT value FROM maintenance_state WHERE key = 'crate_deployment_fence'").first()).toEqual({ value: 'infrastructure' });
	await env.BUCKET.put('new-plaintext', 'new note');
	await finish();
	expect(await (await env.BUCKET.get('new-plaintext'))!.text()).toBe('new note');
	expect((await request('/sync/manifest', nextToken)).status).toBe(200);
});

it('rejects an encrypted upload authorized before reset, even if staging starts after completion', async () => {
	const bundle = createVaultKeyBundle();
	state = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode())), mode: 'active' };
	await env.DB.prepare("UPDATE maintenance_state SET value = ? WHERE key = 'e2ee:state'").bind(JSON.stringify(state)).run();
	const keys = await FileKeyAuthority.fromVault(bundle);
	const content = await sealFile({ path: 'late.md', content: new TextEncoder().encode('old secret'), contentType: 'text/markdown', publicData: null }, keys.forPath('late.md'));
	const upload = () => new Request('https://test/sync/upload?path=late.md', { method: 'PUT', body: content.bytes, headers: {
		'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE, 'X-Crate-Expected-Hash': 'absent',
		'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)),
	} });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let staged!: () => void;
	const ready = new Promise<void>(resolve => { staged = resolve; });
	const bucket = new Proxy(env.BUCKET, { get(target, property) {
		if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => { staged(); await gate; return target.put(...args); };
		const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
	} });
	const pending = handleUpload(upload(), bucket, env.DB, undefined, state);
	await ready;
	expect((await start()).status).toBe(200);
	await finish();
	release();
	expect((await pending).status).not.toBe(200);
	expect((await handleUpload(upload(), env.BUCKET, env.DB, undefined, state)).status).not.toBe(200);
	expect(await getStoredFileRow(env.DB, 'late.md')).toBeNull();
});
