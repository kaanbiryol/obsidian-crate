/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex } from './auth';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';
import { drainNotificationProjections } from './notification-projection';
import { writeCommittedMarkdownFilePair } from './atomic-markdown-write';

const id = '11111111-1111-4111-8111-111111111111';
const valid = `- [ ] Due @2099-01-02T10:00:00.000Z <!-- crate-id:${id} -->`;
const invalidDescriptions = ['<!-- crate-desc:v1:%invalid -->', '<!-- crate-desc:v2:unsupported -->', '<!-- crate-desc:v1:unfinished'];
const invalid = `${valid}\n${invalidDescriptions[0]}\n`;
interface Uploaded { hash: string; revision: string }

beforeEach(async () => {
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES ('device', ?, 'vault')")
		.bind(await sha256Hex('parse-token')).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function request(route: string, init: RequestInit = {}) {
	return worker.fetch(new Request(`https://parse.test${route}`, {
		...init, headers: { Authorization: 'Bearer parse-token', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), ...init.headers },
	}), env);
}
function upload(path: string, content: string, expectedHash = 'absent') {
	return request(`/sync/upload?path=${encodeURIComponent(path)}`, {
		method: 'PUT', body: content, headers: { 'X-Crate-Expected-Hash': expectedHash },
	});
}
async function put(path: string, content: string, expectedHash?: string): Promise<Uploaded> {
	const response = await upload(path, content, expectedHash);
	expect(response.status).toBe(200);
	return response.json() as Promise<Uploaded>;
}
async function configure() {
	expect((await request('/reminders/notification-policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00' }) })).status).toBe(200);
}
async function rows(table: string) { return (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results; }
async function quarantine(path: string) {
	return env.DB.prepare('SELECT job_token, last_error FROM notification_projection_jobs WHERE path = ?').bind(path).first<{ job_token: string; last_error: string | null }>();
}
async function retryProjection() {
	await env.DB.prepare("UPDATE notification_projection_jobs SET updated_at = datetime('now', '-2 hours')").run();
	await drainNotificationProjections(env);
}

for (const policy of ['none', 'outside', 'inside']) {
	it.each(invalidDescriptions)(`publishes opaque bytes and retains the previous version with ${policy} policy: %s`, async description => {
		if (policy !== 'none') await configure();
		const path = policy === 'inside' ? 'Reminders/Inbox.md' : 'Notes/Ordinary.md';
		const first = await put(path, 'Previous bytes\r\nCafé 😀\n');
		const content = `# Café 😀\r\n${valid}\n${description}\n`;
		const current = await put(path, content, first.hash);
		expect(await (await request(`/sync/download?path=${encodeURIComponent(path)}`)).text()).toBe(content);
		expect(await (await env.BUCKET.get(first.revision))?.text()).toBe('Previous bytes\r\nCafé 😀\n');
		expect(await rows('file_versions')).toMatchObject([{ storage_key: first.revision, hash: first.hash, reason: 'replaced' }]);
		expect(await (await request(`/sync/versions?path=${encodeURIComponent(path)}`)).json()).toMatchObject({ versions: [{ storage_key: first.revision }] });
		expect(await rows('changelog')).toHaveLength(2);
		expect((await quarantine(path))?.last_error).toContain('vault file remains synced');
		await retryProjection();
		expect((await quarantine(path))?.last_error).toContain('vault file remains synced');
		expect(await (await request('/diagnostics')).json()).toMatchObject({
			counts: { failedNotificationProjections: 1 }, notificationProjectionIssues: [{ path, reason: expect.stringContaining('Repair') as string }],
		});
		expect((await put(path, valid, current.hash)).hash).toBe(await sha256Hex(valid));
		expect((await quarantine(path))?.last_error).toBeNull();
		await drainNotificationProjections(env);
		if (policy === 'inside') expect(await rows('notification_jobs')).toMatchObject([{ reminder_id: id, operation: 'schedule' }]);
	});
}

it('quarantines an uncertain replacement without cancelling or changing verified reminder ownership', async () => {
	await configure();
	const path = 'Reminders/Inbox.md';
	const first = await put(path, valid);
	await drainNotificationProjections(env);
	const tables = ['reminder_sources', 'reminder_occurrences', 'reminder_projections', 'notification_jobs'];
	const before = await Promise.all(tables.map(rows));
	const changed = await put(path, invalid.replace('- [ ]', '- [x]'), first.hash);
	await retryProjection();
	expect(await Promise.all(tables.map(rows))).toEqual(before);
	// A healthy source in the same folder remains usable, and cached issues stay visible.
	const otherId = '22222222-2222-4222-8222-222222222222';
	await put('Reminders/Healthy.md', valid.replace(id, otherId));
	for (let index = 0; index < 2; index++) {
		const list = await request('/reminders/list?folderPath=Reminders');
		expect(list.status).toBe(200);
		expect(await list.json()).toMatchObject({ reminders: [{ id: otherId }], issues: [{ path, reason: expect.stringContaining('Repair') as string }] });
		expect(list.headers.has('ETag')).toBe(false);
	}
	await put(path, valid.replace('Due', 'Repaired'), changed.hash);
	await drainNotificationProjections(env);
	expect(await quarantine(path)).toBeNull();
	const list = await request('/reminders/list?folderPath=Reminders');
	expect(await list.json()).toMatchObject({ issues: [] });
	expect(await env.DB.prepare('SELECT payload_json FROM notification_jobs WHERE reminder_id = ?').bind(id).first()).toMatchObject({ payload_json: expect.stringContaining('Repaired') as string });
});

it('publishes quarantine atomically even when the D1 commit response is lost', async () => {
	const batch = env.DB.batch.bind(env.DB);
	vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => { await batch(statements); throw new Error('lost response'); });
	expect((await upload('Notes/Ordinary.md', invalid)).status).toBe(503);
	expect(await (await request('/sync/download?path=Notes%2FOrdinary.md')).text()).toBe(invalid);
	expect((await quarantine('Notes/Ordinary.md'))?.last_error).toContain('Repair');
	await put('Notes/Ordinary.md', invalid); // Idempotent retry preserves the committed quarantine.
	expect(await rows('changelog')).toHaveLength(1);
});

it.each([{ kind: 'malformed', content: invalid }, { kind: 'oversized', content: `${valid}\n${'a'.repeat(1024 * 1024)}` }])('retains verified state for a $kind source after a policy change', async ({ content }) => {
	await configure();
	const path = 'Reminders/Inbox.md';
	const first = await put(path, valid);
	await drainNotificationProjections(env);
	const before = await rows('notification_jobs');
	await put(path, content, first.hash);
	const policy = await env.DB.prepare('SELECT revision FROM notification_policy').first<{ revision: string }>();
	expect((await request('/reminders/notification-policy', { method: 'PUT', body: JSON.stringify({ folderPath: 'Other', timezone: 'UTC', allDayTime: '09:00', expectedRevision: policy!.revision }) })).status).toBe(200);
	await drainNotificationProjections(env);
	expect(await rows('notification_jobs')).toEqual(before);
	expect((await quarantine(path))?.last_error).toContain('vault file remains synced');
});

it('permits explicit deletion of a quarantined source to cancel its verified reminders', async () => {
	await configure();
	const path = 'Reminders/Inbox.md';
	const first = await put(path, valid);
	await drainNotificationProjections(env);
	const current = await put(path, invalid, first.hash);
	expect((await request('/sync/delete', { method: 'POST', body: JSON.stringify({ path, expectedHash: current.hash, expectedRevision: current.revision }) })).status).toBe(200);
	await drainNotificationProjections(env);
	expect(await quarantine(path)).toBeNull();
	expect(await rows('reminder_sources')).toEqual([]);
	expect(await rows('notification_jobs')).toMatchObject([{ reminder_id: id, operation: 'cancel' }]);
});

it('does not publish quarantine for a failed compare-and-swap or rolled-back transaction', async () => {
	const path = 'Notes/Ordinary.md';
	await put(path, 'current');
	const before = await quarantine(path);
	expect((await upload(path, invalid, '0'.repeat(64))).status).toBe(409);
	expect(await quarantine(path)).toEqual(before);
	await env.DB.prepare("CREATE TRIGGER reject_projection BEFORE INSERT ON notification_projection_jobs BEGIN SELECT RAISE(ABORT, 'test quarantine failure'); END").run();
	expect((await upload('Notes/Rejected.md', invalid)).status).toBe(503);
	expect(await quarantine('Notes/Rejected.md')).toBeNull();
	expect((await request('/sync/download?path=Notes%2FRejected.md')).status).toBe(404);
});

it('accepts malformed metadata in batch uploads, atomic pairs, and retained-version restores', async () => {
	const path = 'Notes/Batch.md';
	const response = await request('/sync/batch-upload', { method: 'POST', body: JSON.stringify({ files: [{ path, content: btoa(invalid), expectedHash: null }] }) });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ results: [{ success: true }] });
	const old = await env.DB.prepare('SELECT hash, storage_key AS revision FROM files WHERE path = ?').bind(path).first<Uploaded>();
	const source = await put('Notes/Source.md', 'source');
	await writeCommittedMarkdownFilePair(env.BUCKET, env.DB, {
		source: { path: 'Notes/Source.md', content: invalid, expectedHash: source.hash },
		destination: { path: 'Notes/Destination.md', content: invalid, expectedHash: null },
	});
	for (const affected of ['Notes/Source.md', 'Notes/Destination.md']) {
		expect(await (await request(`/sync/download?path=${encodeURIComponent(affected)}`)).text()).toBe(invalid);
		expect((await quarantine(affected))?.last_error).toContain('Repair');
	}
	const repaired = await put(path, valid, old!.hash);
	expect((await request('/sync/restore-version', { method: 'POST', body: JSON.stringify({ storageKey: old!.revision, expectedHash: repaired.hash }) })).status).toBe(200);
	expect(await (await request(`/sync/download?path=${encodeURIComponent(path)}`)).text()).toBe(invalid);
	expect((await quarantine(path))?.last_error).toContain('Repair');
});
