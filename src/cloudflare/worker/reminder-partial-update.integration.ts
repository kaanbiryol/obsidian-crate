import { createReminderOperationId } from '@/protocol/reminder-operation';
/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from './storage';
import { handleListReminders } from './reminders-web/routes/list';
import { handleUpdateReminder } from './reminders-web/routes/update';
import { appendCreatedReminderBlock, buildCreatedReminderBlock } from '@/reminders/core/markdownReminderMutation';
import type { ReminderRecord } from '@/pwa/types';

beforeEach(async () => { for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { await reset(); });
const path = 'Reminders/Inbox.md';
async function reminder() {
	const response = await handleListReminders(new Request('https://test/reminders/list?folderPath=Reminders'), env);
	return (await response.json() as { reminders: ReminderRecord[] }).reminders[0]!;
}
async function setup() {
	const content = appendCreatedReminderBlock('# Inbox\n', buildCreatedReminderBlock({ content: 'Original',
		description: 'Important details', dueDate: new Date('2099-09-09T09:00:00Z'), hasTime: true, priority: 4,
		recurrence: { frequency: 'daily', timezone: 'Europe/Berlin', count: 5, completedCount: 1 }, reminderId: 'one' }));
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
		expect(after[field], field).toEqual(before[field]);
	}
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, after.filePath))?.content).toContain('crate-desc:v1:Important%20details');
});

it.each(['', null])('honors an explicit description clear through the API: %j', async description => {
	const before = await setup();
	expect((await update({ description }, before.revision!)).status).toBe(200);
	expect((await reminder()).description).toBeUndefined();
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))?.content).not.toContain('crate-desc:');
});

const issuedDay = Math.floor(Date.now() / 86_400_000);
function newOperationId() { return createReminderOperationId(issuedDay); }
