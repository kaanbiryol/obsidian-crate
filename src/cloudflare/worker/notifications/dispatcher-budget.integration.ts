/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { applySchema } from '../test-support/schema-test-harness';
import { installStorageCostMeter, type StorageCostMeter } from '../test-support/storage-cost-test-harness';
import worker from '../index';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../sync/markdown-files';
import { scanReminderMarkdownContent } from '@/reminders/core/markdownScan';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { reminderRevision } from '@/reminders/core/reminderRevision';
import { sha256Hex } from '@/platform/sha256';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { wakeReminderDispatcher, DISPATCH_BATCH_SIZE } from './dispatcher';
import { D1_QUERIES_PER_INVOCATION } from '../d1/platform-limits';

// Measures what reminder notification delivery adds to projection, now that one dispatcher
// alarm serves every schedule. Before the redesign, with one Durable Object per reminder and
// a D1 outbox, the same edit with its alarms cost 36 queries, 23 written rows, 4 Durable
// Object requests and 2 alarms: the outbox job, the drain on the dispatcher role, then the
// reminder's own instance, which re-read the job and mirrored its schedule into D1. Each
// delivery then ran in that reminder's own alarm with 7 queries: features, the mirrored
// schedule, two authority reads, recipients, VAPID keys and the cleanup delete.
let meter: StorageCostMeter;
const PATH = 'Reminders/Budget.md';
const COUNT = DISPATCH_BATCH_SIZE;
const note = () => `# Tasks\n\n${Array.from({ length: COUNT }, (_, index) =>
	`- [ ] Task ${index} 2099-01-0${1 + (index % 9)}T09:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`).join('\n')}\n`;

function send(path: string, body?: string) {
	return worker.fetch(new Request(`https://crate.test${path}`, { method: body ? 'POST' : 'GET', body,
		headers: { Authorization: 'Bearer web-session', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), 'Content-Type': 'application/json' } }), env);
}
async function editBody(index: number, dueDatetime: string) {
	const reminder = scanReminderMarkdownContent(PATH, (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, PATH))!.content, 'Reminders').reminders[index]!;
	return JSON.stringify({ operationId: createReminderOperationId(Math.floor(Date.now() / 86_400_000)), id: reminder.id, folderPath: 'Reminders',
		filePath: PATH, expectedRevision: await reminderRevision(reminder), dueDatetime });
}

beforeAll(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope, folder_path, last_seen_at) VALUES ('web', ?, 'reminders', 'Reminders', datetime('now'))")
		.bind(await sha256Hex('web-session')).run();
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, PATH, note(), null);
	meter = await installStorageCostMeter();
	for (let attempt = 0; attempt < 20 && (await send('/reminders/list?folderPath=Reminders')).status === 202; attempt++);
	await meter.settle();
}, 120_000);
afterAll(async () => { await meter?.restore(); });

it('moves a schedule with one dispatcher request and no outbox queries or rows', async () => {
	const names = vi.spyOn(env.REMINDER_ALARMS, 'idFromName');
	const body = await editBody(3, '2099-02-01T09:00:00.000Z');
	const edit = await meter.measure(() => send('/reminders/update', body));
	expect(edit.result.status, await edit.result.clone().text()).toBe(200);
	// Was 36 queries, 23 rows, 4 Durable Object requests and 2 alarms.
	expect(edit.cost).toMatchObject({ queries: 21, rowsWritten: 20, durableObjectRequests: 3, alarms: 1 });
	// The schedule rides in the projection row the commit already writes; delivery opens no
	// per-reminder object.
	const opened = names.mock.calls.map(([name]) => name);
	names.mockRestore();
	expect(opened.filter(name => !name.startsWith('__crate__/'))).toEqual([]);
	expect(await env.DB.prepare('SELECT due_at FROM reminder_projections WHERE due_datetime = ?').bind('2099-02-01T09:00:00.000Z').first())
		.toEqual({ due_at: Date.parse('2099-02-01T09:00:00.000Z') });
	// The dispatcher's share of a change, measured alone.
	const wake = await meter.measure(() => wakeReminderDispatcher(env, Date.parse('2099-01-01T09:00:00.000Z')));
	console.info('schedule change cost', { edit: edit.cost, dispatcher: wake.cost });
	expect(wake.cost).toMatchObject({ durableObjectRequests: 1, queries: 0, rowsWritten: 0 });
}, 60_000);

it(`delivers ${COUNT} due reminders in one bounded pass`, async () => {
	await env.DB.prepare('UPDATE reminder_projections SET due_at = ? WHERE due_at IS NOT NULL').bind(Date.now()).run();
	const { cost } = await meter.measure(() => wakeReminderDispatcher(env));
	console.info(`delivery cost for ${COUNT} reminders`, cost);
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_projections WHERE delivered_due IS NOT NULL AND due_at IS NULL').first()).toEqual({ n: COUNT });
	// Was 7 queries per delivery, 140 for this batch. The wake reads the earliest due time; the
	// pass reads features, due rows, authority and recipients, then writes every outcome and
	// reads the next due time in one batch.
	expect(cost.alarms).toBe(1);
	expect(cost.queries).toBe(6);
	expect(cost.rowsWritten).toBe(COUNT);
	expect(cost.queries).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
	expect(cost.durableObjectRequests).toBe(1);
}, 60_000);
