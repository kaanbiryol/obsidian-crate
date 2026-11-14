/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../../test-support/schema-test-harness';
import { createEncryptionFixture, storeEncryptionState } from '../../test-support/encryption-test-harness';
import { SyncTestDevice } from '../../test-support/sync-engine-test-harness';
import { beginInitialImport, finishInitialImport } from './initial-import';
import { uploadInitialFiles } from './initial-import-upload';
import { finishInitialReminderSetup, INITIAL_REMINDERS_PENDING } from './initial-import-readiness';
import { runNotificationCoordinator } from '../../notifications/coordinator';
import { saveEncryptionState } from '../../encryption/state';
import { sealFile } from '../../../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../../../encryption/file-format';
import { ENCRYPTION_GENERATION_HEADER, ENCRYPTION_VAULT_HEADER } from '../../../../encryption/server-state';
import { createReminderProjection } from '../../../../reminders/core/encrypted-schedule-projection';
import { parseEncryptedNotification } from '../../../../encryption/notification-format';
import { importInventoryPages, INITIAL_IMPORT_CAPABILITY } from '@/protocol/initial-import';
import type { BatchUploadResponse } from '@/protocol/sync-types';
import type { ReminderSetupStatus } from '@/protocol/initial-import';
import { INITIAL_IMPORT_HEADER } from '@/protocol/http-headers';
import worker from '../../index';
import { unpackDescriptor } from '../../encryption/descriptor-column';

type Fixture = Awaited<ReturnType<typeof createEncryptionFixture>>;
let fixture: Fixture;
const devices: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await applySchema(env.DB);
	fixture = await createEncryptionFixture('active');
	await storeEncryptionState(env.DB, fixture.state);
});
afterEach(async () => { for (const device of devices.splice(0)) device.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

const authority = () => ({ [ENCRYPTION_VAULT_HEADER]: fixture.state.vaultId, [ENCRYPTION_GENERATION_HEADER]: String(fixture.state.generation) });
const json = (body: unknown) => new Request('https://test', { method: 'POST', body: JSON.stringify(body) });
async function start(): Promise<string> {
	const response = await beginInitialImport(env.DB, fixture.state);
	return ((await response.json()) as { import: { token: string } }).import.token;
}
/** Seals `plain` as an encrypted client does, with reminder schedules for notes in Reminders. */
async function seal(plain: string, text: string) {
	const content = new TextEncoder().encode(text), wire = await fixture.paths.wire(plain);
	const publicData = plain.startsWith('Reminders/') ? await createReminderProjection(fixture.notifications, ['Reminders'], plain, content.buffer) : null;
	const sealed = await sealFile({ path: plain, content, publicData }, fixture.keys.forPath(wire));
	return { wire, sealed };
}
const batchFile = ({ wire, sealed }: Awaited<ReturnType<typeof seal>>, contentType = ENCRYPTED_FILE_CONTENT_TYPE) => ({
	path: wire, hash: sealed.hash, contentType, expectedHash: null,
	content: btoa(Array.from(sealed.bytes, byte => String.fromCharCode(byte)).join('')),
});
async function send(token: string, files: unknown[], headers: Record<string, string> = authority()) {
	const response = await uploadInitialFiles(new Request('https://test', { method: 'POST', headers: { [INITIAL_IMPORT_HEADER]: token, ...headers },
		body: JSON.stringify({ files }) }), env.BUCKET, env.DB);
	return { status: response.status, body: await response.json() as BatchUploadResponse & { code?: string } };
}
async function finish(token: string) {
	const rows = await env.DB.prepare('SELECT path, hash, size FROM files').all<{ path: string; hash: string; size: number }>();
	const pages = importInventoryPages(Object.fromEntries(rows.results.map(row => [row.path, row])));
	let after = '', response!: Response;
	for (const [index, entries] of pages.entries()) {
		response = await finishInitialImport(json({ token, after, entries, final: index === pages.length - 1 }), env.DB);
		if (index < pages.length - 1) after = ((await response.clone().json()) as { cursor: string }).cursor;
	}
	return response;
}

it('opens an import in an active encrypted vault and commits ciphertext with its descriptors', async () => {
	const token = await start();
	const notes = await Promise.all([seal('Notes/a.md', '# Private A'), seal('Notes/b.md', '# Private B')]);
	const { status, body } = await send(token, notes.map(note => batchFile(note)));
	expect(status, JSON.stringify(body)).toBe(200);
	expect(body.success).toBe(true);
	for (const note of notes) {
		const row = await env.DB.prepare('SELECT hash, storage_key, descriptor FROM files WHERE path = ?').bind(note.wire).first<{ hash: string; storage_key: string; descriptor: string }>();
		expect(row?.hash).toBe(note.sealed.hash);
		expect(unpackDescriptor(row!.descriptor)).toEqual(note.sealed.descriptor);
		expect(await (await env.BUCKET.get(row!.storage_key))!.text()).not.toContain('Private');
	}
	// The import writes no changelog entry, receipt or lease that outlives it.
	for (const table of ['changelog', 'operations', 'upload_leases']) expect(await env.DB.prepare(`SELECT 1 FROM ${table}`).first(), table).toBeNull();
	expect((await finish(token)).status).toBe(200);
	expect(await env.DB.prepare("SELECT import_state AS state FROM server_state").first()).toEqual({ state: 'complete' });
});

it('refuses plaintext and requests without the vault keys before storing anything', async () => {
	const token = await start();
	const note = await seal('Notes/a.md', '# A');
	const text = '# Plaintext';
	const plaintext = { path: note.wire, hash: await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(digest => Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')),
		contentType: 'text/markdown', expectedHash: null, content: btoa(text) };
	const put = vi.spyOn(env.BUCKET, 'put');
	expect(await send(token, [plaintext])).toMatchObject({ status: 428, body: { code: 'encryption_required' } });
	expect(await send(token, [batchFile(note)], {})).toMatchObject({ status: 428, body: { code: 'encryption_required' } });
	expect(put).not.toHaveBeenCalled();
	for (const table of ['files', 'upload_leases']) expect(await env.DB.prepare(`SELECT 1 FROM ${table}`).first(), table).toBeNull();
	// The server advertises the import in an encrypted vault too.
	expect((await worker.fetch(new Request('https://test/.well-known/crate'), env).then(response => response.json()) as { capabilities: string[] }).capabilities)
		.toContain(INITIAL_IMPORT_CAPABILITY);
});

it('is fenced by a reset that starts while a batch is staged', async () => {
	const token = await start();
	const put = env.BUCKET.put.bind(env.BUCKET);
	vi.spyOn(env.BUCKET, 'put').mockImplementationOnce(async (...args) => {
		// The reset begins between the lease and the publication.
		await env.DB.batch([saveEncryptionState(env.DB, { ...fixture.state, mode: 'resetting' }),
			env.DB.prepare("INSERT INTO server_state(id, reset_generation) VALUES (1, 'reset') ON CONFLICT(id) DO UPDATE SET reset_generation = 'reset'")]);
		return put(...args);
	});
	const { body } = await send(token, [batchFile(await seal('Notes/a.md', '# A'))]);
	expect(body.success).toBe(false);
	expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
	// Later batches are refused before staging.
	expect((await send(token, [batchFile(await seal('Notes/b.md', '# B'))])).status).toBe(428);
});

it('resumes after a lost batch response without storing the bytes again', async () => {
	const token = await start();
	const notes = await Promise.all(Array.from({ length: 4 }, (_, i) => seal(`Notes/${i}.md`, `# ${i}`)));
	const batch = env.DB.batch.bind(env.DB);
	vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => { await batch(statements); throw new Error('response lost'); });
	await expect(send(token, notes.map(note => batchFile(note)))).rejects.toThrow('response lost');
	const put = vi.spyOn(env.BUCKET, 'put');
	const retried = await send(token, notes.map(note => batchFile(note)));
	expect(retried.body.success).toBe(true);
	expect(put).not.toHaveBeenCalled();
	expect((await finish(token)).status).toBe(200);
});

it('completes reminder readiness from the public data of encrypted reminder notes', async () => {
	const folder = await fixture.paths.wire('Reminders');
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, ?, 'UTC', 'policy')").bind(folder).run();
	const token = await start();
	const note = await seal('Reminders/Inbox.md', '- [ ] Private appointment 2099-01-02T10:00:00.000Z <!-- crate-id:r1 -->');
	expect((await send(token, [batchFile(note)])).body.success).toBe(true);
	expect((await finish(token)).status).toBe(200);
	expect(await env.DB.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(INITIAL_REMINDERS_PENDING).first()).toEqual({ value: token });
	const readiness = async () => (await finishInitialReminderSetup(json({ token }), env.DB)).json() as Promise<ReminderSetupStatus>;
	for (let pass = 0; pass < 5 && !(await readiness()).ready; pass++) {
		await runNotificationCoordinator({ storage: { setAlarm: vi.fn(), get: vi.fn(), put: vi.fn() } } as never, env);
	}
	expect(await readiness()).toEqual({ ready: true });
	const alarm = await env.DB.prepare("SELECT content FROM reminder_projections WHERE reminder_id = 'r1'").first<{ content: string }>();
	expect(alarm?.content).not.toContain('Private');
	expect(parseEncryptedNotification(alarm!.content)).toMatchObject({ vaultId: fixture.bundle.vaultId, reminderId: 'r1' });
});

it('uploads an encrypted first sync through the import and resumes it on a restarted device', async () => {
	const device = new SyncTestDevice('encrypted-import', env); devices.push(device);
	await device.authorize(3600_000);
	const open = async () => { await device.open(); await device.api.configureEncryption(fixture.bundle, () => ['Reminders'], () => 'Reading'); };
	await open();
	for (let i = 0; i < 40; i++) device.disk.write(`note-${i}.md`, `# Note ${i}`);
	const finish = vi.spyOn(device.api.initialImport, 'finish').mockRejectedValueOnce(new Error('offline'));
	expect((await device.engine.sync()).errors).toEqual(['offline']);
	finish.mockRestore();
	device.close(); await open();
	device.disk.write('note-0.md', '# Note 0, edited');
	device.disk.write('new.md', '# New');
	const upload = vi.spyOn(device.api.initialImport, 'upload');
	const result = await device.engine.sync();
	expect(result.errors).toEqual([]);
	// Only the changed and new files were sent again.
	expect(upload.mock.calls.flatMap(([, files]) => files.map(file => file.path)).sort()).toEqual(['new.md', 'note-0.md']);
	expect(await env.DB.prepare("SELECT import_state AS state FROM server_state").first()).toEqual({ state: 'complete' });
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE descriptor IS NOT NULL').first()).toEqual({ n: 41 });
	for (const table of ['changelog', 'operations']) expect(await env.DB.prepare(`SELECT 1 FROM ${table}`).first(), table).toBeNull();
	// Another device reads the vault back in plaintext.
	const other = new SyncTestDevice('encrypted-reader', env); devices.push(other);
	await other.authorize(3600_000); await other.open();
	await other.api.configureEncryption(fixture.bundle, () => ['Reminders'], () => 'Reading');
	expect((await other.engine.sync()).errors).toEqual([]);
	expect(other.disk.text('note-0.md')).toBe('# Note 0, edited');
	expect(other.disk.text('new.md')).toBe('# New');
});

it('recovers on the next sync when an encrypted import batch commits but its response is lost', async () => {
	const device = new SyncTestDevice('encrypted-lost-batch', env); devices.push(device);
	await device.authorize(3600_000); await device.open();
	await device.api.configureEncryption(fixture.bundle, () => ['Reminders'], () => 'Reading');
	for (let i = 0; i < 10; i++) device.disk.write(`note-${i}.md`, `# Note ${i}`);
	// The batch commits on the server; the device never hears back.
	const upload = device.api.initialImport.upload.bind(device.api.initialImport);
	vi.spyOn(device.api.initialImport, 'upload').mockImplementationOnce(async (...args) => { await upload(...args); throw new Error('response lost'); });
	expect((await device.engine.sync()).errors).toEqual(Array.from({ length: 10 }, (_, i) => `note-${i}.md: response lost`));
	// Each retry seals new bytes, so the device resumes from the committed copies instead.
	expect((await device.engine.sync()).errors).toEqual([]);
	expect(await env.DB.prepare('SELECT import_state AS state FROM server_state').first()).toEqual({ state: 'complete' });
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE descriptor IS NOT NULL').first()).toEqual({ n: 10 });
	const other = new SyncTestDevice('encrypted-lost-batch-reader', env); devices.push(other);
	await other.authorize(3600_000); await other.open();
	await other.api.configureEncryption(fixture.bundle, () => ['Reminders'], () => 'Reading');
	expect((await other.engine.sync()).errors).toEqual([]);
	expect(other.disk.text('note-9.md')).toBe('# Note 9');
});
