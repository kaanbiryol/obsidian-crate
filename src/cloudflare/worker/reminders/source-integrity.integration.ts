/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { writeCommittedMarkdownFilePair } from '../sync/atomic-markdown-write';
import { drainNotificationProjections } from '../notifications/projection';
import { handleNotificationPolicy } from '../notifications/policy';
import { handleListReminders } from './handlers/list';
import { handleBatchDelete } from '../sync/batch/delete';
import { getStoredFileRow } from '../sync/storage';
import { deliverDueReminders } from '../notifications/dispatcher';
import { sendToAllSubscriptions } from '../notifications/push';
import { handleDiagnostics } from '../maintenance/diagnostics';
import { assertUniqueReminderSources } from './source-identity';

vi.mock('../notifications/push', () => ({
	listPushSubscriptions: vi.fn(async () => [{ id: 'sub', endpoint: 'https://push.example/sub', p256dh: 'key', auth: 'auth' }]),
	sendToAllSubscriptions: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0, quarantined: 0, errors: [], failedSubscriptionIds: [] })),
}));
beforeEach(async () => {
	await applySchema(env.DB);
	await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00' }) }), env.DB);
});
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await reset(); });
const id = '11111111-1111-4111-8111-111111111111';
const note = (title: string, due: string, done = false) => `- [${done ? 'x' : ' '}] ${title} @${due} <!-- crate-id:${id} -->`;
const list = async (): Promise<unknown> => (await handleListReminders(new Request('https://test/reminders/list?folderPath=Reminders'), env)).json() as Promise<unknown>;
async function remove(path: string) {
	const file = await getStoredFileRow(env.DB, path);
	expect(await (await handleBatchDelete(new Request('https://test/delete', { method: 'POST', body: JSON.stringify({ files: [{ path, expectedHash: file?.hash, expectedRevision: file?.storageKey }] }) }), env.BUCKET, env.DB)).json()).toMatchObject({ deleted: [path] });
}
/** The reminder's scheduled occurrence, or null when nothing is scheduled. */
async function command() {
	return env.DB.prepare('SELECT due_datetime, content, due_at FROM reminder_projections WHERE reminder_id = ? AND due_datetime IS NOT NULL').bind(id).first<{ due_datetime: string; content: string; due_at: number | null }>();
}
const scheduled = { due_datetime: expect.any(String) as string };
/** Runs a dispatcher pass with the scheduled attempt brought forward. */
async function deliver() {
	await env.DB.prepare('UPDATE reminder_projections SET due_at = ? WHERE due_at IS NOT NULL').bind(Date.now()).run();
	await deliverDueReminders(env);
}

it.each(['unchanged', 'title edit', 'project move', 'rename'])('delivers a first projection delayed across its deadline (%s)', async action => {
	const now = Date.now();
	const due = new Date(now + 60_000).toISOString();
	const content = note('Due', due);
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', content, null);
	vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
	if (action === 'title edit') await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', note('Edited', due), first.hash);
	if (action === 'project move') await writeCommittedMarkdownFilePair(env.BUCKET, env.DB, { source: { path: 'Reminders/A.md', content: '', expectedHash: first.hash }, destination: { path: 'Reminders/B.md', content, expectedHash: null } });
	if (action === 'rename') { await remove('Reminders/A.md'); await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/B.md', content, null); }
	await drainNotificationProjections(env);
	expect(await command()).toMatchObject(scheduled);
	await deliver();
	expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
});

it('does not notify newly imported historical reminders', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', note('Historical', new Date(Date.now() - 60_000).toISOString()), null);
	await drainNotificationProjections(env);
	expect(await command()).toBeNull();
});

it('records a missed delivery after the late window instead of sending or silently cancelling', async () => {
	const now = Date.now();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/A.md', note('Due', new Date(now + 60_000).toISOString()), null);
	vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60_000);
	await drainNotificationProjections(env);
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).not.toHaveBeenCalled();
	expect(await command()).toMatchObject({ due_at: null });
	expect(await (await handleDiagnostics(env.DB)).json()).toMatchObject({ counts: { failedNotificationDeliveries: 1 } });
});

it.each(['A', 'Z'])('quarantines duplicate ownership, rejects edits, and resumes after repair (original %s)', async original => {
	const originalPath = `Reminders/${original}.md`;
	const duplicatePath = 'Reminders/M.md';
	const due = '2099-01-02T10:00:00.000Z';
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, originalPath, note('Original', due), null);
	await drainNotificationProjections(env);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, duplicatePath, note('Copied and completed', due, true), null);
	await drainNotificationProjections(env);
	expect(await command()).toMatchObject(scheduled);
	expect(await env.DB.prepare('SELECT file_path FROM reminder_projections WHERE reminder_id = ?').bind(id).first()).toMatchObject({ file_path: originalPath });
	const listing = await list() as { reminders: unknown[]; issues: Array<{ path: string; reason: string }> };
	expect(listing.reminders).toEqual([]);
	expect(listing.issues.map(issue => issue.path).sort()).toEqual([originalPath, duplicatePath].sort());
	for (const issue of listing.issues) expect(issue.reason).toContain('Duplicate');
	await expect(assertUniqueReminderSources(env.DB, 'Reminders', [id])).rejects.toThrow('Duplicate');
	await remove(duplicatePath);
	await drainNotificationProjections(env);
	expect((await env.DB.prepare('SELECT last_error FROM notification_projection_jobs WHERE last_error IS NOT NULL').all()).results).toEqual([]);
	expect(await command()).toMatchObject(scheduled);
	expect(await list()).toMatchObject({ reminders: [{ id, filePath: originalPath }], issues: [] });
});
