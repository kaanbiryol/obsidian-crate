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
import { ENCRYPTION_STATE_KEY } from './encryption-state';
import { handleEncryptionConversion } from './encryption-conversion';
import { handleUpload } from './sync-file-handlers';
import { createReminderOperationId } from '../../protocol/reminder-operation';
import { REMINDER_CACHE_PARSER_VERSION } from './reminders-web/reminder-cache/types';
import { revalidateReminderSources } from './reminder-source-migration';
import { drainNotificationProjections } from './notification-projection';
import { drainNotificationJobs } from './notification-outbox';
import { runNotificationCoordinator } from './notification-coordinator';

beforeEach(async () => { for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function fixture(padding: number, count = 1) {
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const state = createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode()));
	state.mode = 'active';
	await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(ENCRYPTION_STATE_KEY, JSON.stringify(state)).run();
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
	const keys = await FileKeyAuthority.fromVault(bundle), path = 'Reminders/Inbox.md';
	const content = new TextEncoder().encode('x'.repeat(padding) + '\n\n' + Array.from({ length: count }, (_, index) =>
		`- [ ] Important appointment 2099-01-02T10:00:00.000Z <!-- crate-id:r${index} -->`).join('\n'));
	expect(content.byteLength).toBeLessThanOrEqual(1024 * 1024);
	const file = await sealFile({ path, content, contentType: 'text/markdown', publicData: await createReminderProjection(bundle, path, content.buffer) }, keys.forPath(path));
	const response = await handleUpload(new Request(`https://test/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: file.bytes, headers: {
		'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE, 'X-File-Hash': file.hash, 'X-File-Size': String(file.bytes.length),
		'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)),
	} }), env.BUCKET, env.DB);
	expect(response.status, await response.clone().text()).toBe(200);
	return { state, file, path, bundle, keys };
}

it.each([64, 800_000])('rebuilds previously indexed notification sources after conversion (%i bytes)', async padding => {
	const { state, file, path } = await fixture(padding);
	if (padding > 1000) expect(file.bytes.length).toBeGreaterThan(1024 * 1024);
	await env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES (?, '')")
		.bind(`reminder_source_scan_portable_v${REMINDER_CACHE_PARSER_VERSION}:Reminders`).run();
	// Resume at activation after bytes and receipts have been converted, while
	// the plaintext-era scan cursor and derived source rows still exist.
	await env.DB.prepare('UPDATE maintenance_state SET value = ? WHERE key = ?').bind(JSON.stringify({ ...state, mode: 'converting' }), ENCRYPTION_STATE_KEY).run();
	await env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES ('e2ee:settings-converted', 'true')").run();
	await env.DB.prepare('UPDATE upload_operations SET response_json = ?').bind(JSON.stringify({ e2eeLegacy: {} })).run();
	const finish = () => handleEncryptionConversion(new Request('https://test/encryption/conversion/finish', { method: 'POST', headers: {
		'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation),
	} }), env, '/encryption/conversion/finish');
	expect((await finish())?.status).toBe(200);
	expect(await env.DB.prepare("SELECT 1 FROM maintenance_state WHERE key LIKE 'reminder_source_scan_%'").first()).toBeNull();
	await revalidateReminderSources(env, 2);
	await drainNotificationProjections(env);
	expect(await env.DB.prepare('SELECT verified FROM reminder_source_state WHERE file_path = ?').bind(path).first()).toEqual({ verified: 1 });
	expect(await env.DB.prepare("SELECT operation FROM notification_jobs WHERE reminder_id = 'r0'").first()).toEqual({ operation: 'schedule' });
	await drainNotificationJobs(env);
	expect(await env.DB.prepare("SELECT 1 FROM scheduled_reminders WHERE reminder_id = 'r0'").first()).not.toBeNull();
	// A lost activation response must not clear the newly verified source again.
	expect((await finish())?.status).toBe(200);
	expect(await env.DB.prepare('SELECT verified FROM reminder_source_state WHERE file_path = ?').bind(path).first()).toEqual({ verified: 1 });
});

it.each(['quarantined', 'missing'])('repairs already-active vaults with %s source verification', async failure => {
	const { path } = await fixture(800_000);
	await env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES ('reminder_source_scan_portable_v10:Reminders', '')").run();
	if (failure === 'quarantined') await env.DB.prepare('UPDATE reminder_source_state SET parser_version = 10, verified = 0').run();
	else await env.DB.prepare('DELETE FROM reminder_source_state').run();
	await env.DB.prepare("INSERT INTO notification_file_retries(path, attempts, available_at, error) VALUES (?, 1, -1, 'old size limit')").bind(path).run();
	await revalidateReminderSources(env, 2);
	await drainNotificationProjections(env);
	expect(await env.DB.prepare('SELECT verified, parser_version FROM reminder_source_state WHERE file_path = ?').bind(path).first())
		.toEqual({ verified: 1, parser_version: REMINDER_CACHE_PARSER_VERSION });
	expect(await env.DB.prepare('SELECT 1 FROM notification_file_retries WHERE path = ?').bind(path).first()).toBeNull();
	expect(await env.DB.prepare("SELECT operation FROM notification_jobs WHERE reminder_id = 'r0'").first()).toEqual({ operation: 'schedule' });
});

it.each([1200, 2000])('rebuilds a valid encrypted source larger than the old byte budget (%i reminders)', async count => {
	const { path, file } = await fixture(800_000, count);
	expect(file.bytes.length).toBeGreaterThan(2 * 1024 * 1024);
	await env.DB.prepare('UPDATE reminder_source_state SET parser_version = 0, verified = 0').run();
	const get = vi.spyOn(env.BUCKET, 'get');
	expect(await revalidateReminderSources(env, 2)).toBe(false);
	expect(get).toHaveBeenCalledOnce();
	expect(await env.DB.prepare('SELECT verified FROM reminder_source_state WHERE file_path = ?').bind(path).first()).toEqual({ verified: 1 });
	await drainNotificationProjections(env);
	expect(await env.DB.prepare('SELECT operation FROM notification_jobs WHERE reminder_id = ?').bind(`r${count - 1}`).first()).toEqual({ operation: 'schedule' });
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM notification_jobs').first()).toEqual({ count });
});

it('rolls back every scheduling chunk on failure and retries without replacing unchanged command tokens', async () => {
	const { path } = await fixture(800_000, 2000);
	const batch = env.DB.batch.bind(env.DB);
	vi.spyOn(env.DB, 'batch').mockImplementationOnce(statements => batch([
		...statements.slice(0, 3),
		env.DB.prepare("INSERT INTO notification_jobs(reminder_id, job_token, operation) VALUES ('injected', NULL, 'schedule')"),
		...statements.slice(3),
	]));
	await drainNotificationProjections(env);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM notification_jobs').first()).toEqual({ count: 0 });
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_projections').first()).toEqual({ count: 0 });
	await env.DB.prepare('UPDATE notification_file_retries SET available_at = 0').run();
	await drainNotificationProjections(env);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM notification_jobs').first()).toEqual({ count: 2000 });
	const before = await env.DB.prepare('SELECT reminder_id, job_token FROM notification_jobs ORDER BY reminder_id').all();
	await env.DB.prepare('INSERT INTO notification_projection_jobs(path, job_token) VALUES (?, ?)').bind(path, 'revisit').run();
	await drainNotificationProjections(env);
	expect((await env.DB.prepare('SELECT reminder_id, job_token FROM notification_jobs ORDER BY reminder_id').all()).results).toEqual(before.results);
});

it('keeps coordinator passes within their query budget while rebuilding two dense encrypted sources', async () => {
	const { bundle, keys } = await fixture(0, 2000);
	const path = 'Reminders/Second.md';
	const content = new TextEncoder().encode(Array.from({ length: 2000 }, (_, index) =>
		`- [ ] Another appointment 2099-01-02T10:00:00.000Z <!-- crate-id:second-${index} -->`).join('\n'));
	const file = await sealFile({ path, content, contentType: 'text/markdown', publicData: await createReminderProjection(bundle, path, content.buffer) }, keys.forPath(path));
	const uploaded = await handleUpload(new Request(`https://test/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: file.bytes, headers: {
		'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE, 'X-File-Hash': file.hash, 'X-File-Size': String(file.bytes.length),
		'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)),
	} }), env.BUCKET, env.DB);
	expect(uploaded.status).toBe(200);
	await env.DB.prepare('UPDATE reminder_source_state SET parser_version = 0, verified = 0').run();
	// Dispatch and individual alarms have separate invocation budgets. Count only
	// this coordinator's queries, leaving their real namespace binding untouched.
	const prepare = vi.fn((sql: string) => env.DB.prepare(sql));
	const measuredDb = { prepare, batch: env.DB.batch.bind(env.DB), exec: env.DB.exec.bind(env.DB) };
	await runNotificationCoordinator({ storage: { setAlarm: vi.fn() } } as never, { ...env, DB: measuredDb });
	expect(prepare.mock.calls.length).toBeLessThanOrEqual(50);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_source_state WHERE verified = 1').first()).toEqual({ count: 1 });
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_projections').first()).toEqual({ count: 2000 });
	prepare.mockClear();
	await runNotificationCoordinator({ storage: { setAlarm: vi.fn() } } as never, { ...env, DB: measuredDb });
	expect(prepare.mock.calls.length).toBeLessThanOrEqual(50);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_source_state WHERE verified = 1').first()).toEqual({ count: 2 });
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_projections').first()).toEqual({ count: 4000 });
});
