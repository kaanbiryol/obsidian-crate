import { createReminderOperationId } from '@/protocol/reminder-operation';
/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../storage';
import { handleListReminders } from './routes/list';
import { handleUpdateReminder } from './routes/update';
import { appendCreatedReminderBlock, buildCreatedReminderBlock } from '@/reminders/core/markdownReminderMutation';
import type { ReminderRecord } from '@/pwa/reminders/types';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { await reset(); });
const path = 'Reminders/Inbox.md';
const rule = { frequency: 'daily' as const, timezone: 'Europe/Berlin', count: 5, completedCount: 1 };
async function reminder() {
	const response = await handleListReminders(new Request('https://test/reminders/list?folderPath=Reminders'), env);
	return (await response.json() as { reminders: ReminderRecord[] }).reminders[0]!;
}
async function setup() {
	const content = appendCreatedReminderBlock('# Inbox\n', buildCreatedReminderBlock({ content: 'Original',
		description: 'Important details', dueDate: new Date('2099-09-09T09:00:00Z'), hasTime: true, priority: 4,
		recurrence: rule, reminderId: 'one' }));
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	return reminder();
}
function update(patch: Record<string, unknown>, expectedRevision: string) {
	return handleUpdateReminder(new Request('https://test/reminders/update', { method: 'POST', body: JSON.stringify({
		folderPath: 'Reminders', id: 'one', filePath: path, operationId: newOperationId(), expectedRevision, ...patch,
	}) }), env);
}

it.each([{ priority: 1 }, { content: 'Updated' }, { project: 'Other' }, { dueDate: '2099-09-10' },
	{ dueDatetime: '2099-09-10T10:00:00Z' }, { recurrence: null }])('preserves omitted description and other fields for a valid API patch: %j', async patch => {
	const before = await setup();
	const response = await update(patch, before.revision!);
	expect(response.status).toBe(200);
	const after = await reminder();
	for (const field of ['content', 'description', 'priority', 'recurrence', 'completed', 'id', 'project', 'dueDate', 'dueDatetime'] as const) {
		if (field in patch || (field === 'dueDate' || field === 'dueDatetime') && ('dueDate' in patch || 'dueDatetime' in patch)) continue;
		// The rule holds the time of a timed due; a date-only due drops it again.
		if (field === 'recurrence' && 'dueDate' in patch) expect(after.recurrence).toEqual(rule);
		else expect(after[field], field).toEqual(before[field]);
	}
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, after.filePath))?.content).toContain('<!-- crate-desc:Important details -->');
});

it('stores description edits literally and returns the same text through the API', async () => {
	const before = await setup();
	const description = 'hello%20world\n100% complete café 😀';
	expect((await update({ description }, before.revision!)).status).toBe(200);
	expect((await reminder()).description).toBe(description);
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))?.content).toContain(`<!-- crate-desc:${description} -->`);
});

it.each(['', null])('honors an explicit description clear through the API: %j', async description => {
	const before = await setup();
	expect((await update({ description }, before.revision!)).status).toBe(200);
	expect((await reminder()).description).toBeUndefined();
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))?.content).not.toContain('crate-desc:');
});

const issuedDay = Math.floor(Date.now() / 86_400_000);
function newOperationId() { return createReminderOperationId(issuedDay); }
