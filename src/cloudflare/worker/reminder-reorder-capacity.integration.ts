/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { handleReorderReminders } from './reminders-web/routes/reorder';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from './storage';
import { scanReminderMarkdownFile } from './reminders-web/scan';

const path = 'Reminders/Inbox.md';
beforeEach(async () => {
	for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { await reset(); });

function reorderRequest(body: Record<string, unknown>) {
	return new Request('https://reorder.test/reminders/reorder', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
			folderPath: 'Reminders', project: 'Inbox', operationId: crypto.randomUUID(), ...body,
		}),
	});
}

it('reorders a page inside a 1,000-reminder project, retains the rest and retries once', async () => {
	const ids = Array.from({ length: 1000 }, () => crypto.randomUUID());
	const content = ids.map((id, index) => `- [ ] Task ${index} <!-- crate-id:${id} -->`).join('\n');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	const orderedIds = [...ids];
	[orderedIds[600], orderedIds[601]] = [ids[601]!, ids[600]!];
	const body = { orderedIds, expectedOrder: ids, operationId: crypto.randomUUID() };
	const response = await handleReorderReminders(reorderRequest(body), env);
	expect(response.status).toBe(200);
	const current = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path);
	expect(current).not.toBeNull();
	expect(scanReminderMarkdownFile(path, current!.content, 'Reminders').map(reminder => reminder.id)).toEqual(orderedIds);
	const changes = await env.DB.prepare('SELECT COUNT(*) AS count FROM changelog').first<{ count: number }>();
	expect((await handleReorderReminders(reorderRequest(body), env)).status).toBe(200);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM changelog').first()).toEqual(changes);
	// A second device's stale project order cannot overwrite the successful drag.
	expect((await handleReorderReminders(reorderRequest({ orderedIds: ids, expectedOrder: ids }), env)).status).toBe(409);
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))?.hash).toBe(current!.hash);
});

it('keeps finite item and JSON byte limits for reorder requests', async () => {
	const ids = Array.from({ length: 10_001 }, (_, index) => `reminder-${index}`);
	expect((await handleReorderReminders(reorderRequest({ orderedIds: ids, expectedOrder: [] }), env)).status).toBe(400);
	expect((await handleReorderReminders(reorderRequest({ orderedIds: [], expectedOrder: [], padding: 'x'.repeat(1024 * 1024) }), env)).status).toBe(413);
});
