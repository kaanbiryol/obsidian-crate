/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex } from './auth';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from './storage';
import { handleListReminders } from './reminders-web/routes/list';
import { handleReorderReminders } from './reminders-web/routes/reorder';
import { handleNotificationPolicy } from './notification-policy';
import { drainNotificationProjections } from './notification-projection';

const path = 'Reminders/Inbox.md';
const first = '- [ ] First 2099-09-09 <!-- crate-id:first -->';
const second = '- [ ] Second <!-- crate-id:second -->';
beforeEach(async () => { for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { await reset(); });

it('excludes fenced examples from identities, list results and notification jobs', async () => {
	await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00' }) }), env.DB);
	const content = `~~~md\n- [ ] Example tomorrow <!-- crate-id:example -->\n<!-- crate-desc:v1:%invalid -->\n~~~\n${first}\n`;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	expect(await env.DB.prepare('SELECT reminder_id FROM reminder_sources').all()).toMatchObject({ results: [{ reminder_id: 'first' }] });
	const listed = await handleListReminders(new Request('https://test/reminders/list?folderPath=Reminders'), env);
	expect(await listed.json()).toMatchObject({ reminders: [{ id: 'first' }], issues: [] });
	await drainNotificationProjections(env);
	expect(await env.DB.prepare('SELECT reminder_id, operation FROM notification_jobs').all()).toMatchObject({ results: [{ reminder_id: 'first', operation: 'schedule' }] });
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))?.content).toBe(content);
});

it('returns an actionable structural reorder conflict without publishing or acknowledging an operation', async () => {
	const content = `${first}\n## Another section\n${second}\n`;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	const operationId = crypto.randomUUID();
	const response = await handleReorderReminders(new Request('https://test/reminders/reorder', {
		method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', project: 'Inbox', operationId,
			orderedIds: ['second', 'first'], expectedOrder: ['first', 'second'] }),
	}), env);
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: 'reminder_order_conflict' });
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))?.content).toBe(content);
	expect(await env.DB.prepare('SELECT operation_id FROM reminder_operations').all()).toMatchObject({ results: [] });
});

it('maps a create inside an unclosed fence to a conflict through the authenticated Worker route', async () => {
	const content = '```md\nExample';
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope, folder_path, expires_at) VALUES (?, ?, 'reminders', ?, ?)")
		.bind('browser', await sha256Hex('browser'), 'Reminders', Date.now() + 60_000).run();
	const response = await worker.fetch(new Request('https://test/reminders/create', { method: 'POST', headers: {
		Authorization: 'Bearer browser', 'X-Crate-Protocol': '5', 'Content-Type': 'application/json',
	}, body: JSON.stringify({ folderPath: 'Reminders', project: 'Inbox', content: 'New task', operationId: crypto.randomUUID() }) }), env);
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: 'reminder_markdown_context' });
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))?.content).toBe(content);
	expect(await env.DB.prepare('SELECT operation_id FROM reminder_operations').all()).toMatchObject({ results: [] });
});
