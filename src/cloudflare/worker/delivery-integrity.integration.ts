/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from './test-support/schema-test-harness';
import { writeCommittedMarkdownFile } from './sync/markdown-files';
import { drainNotificationProjections } from './notifications/projection';
import { handleNotificationPolicy } from './notifications/policy';
import { deliverDueReminders } from './notifications/dispatcher';
import { sendToAllSubscriptions } from './notifications/push';
import { handleDiagnostics } from './maintenance/diagnostics';
vi.mock('./notifications/push', () => ({ listPushSubscriptions: vi.fn(async () => [{ id: 'sub', endpoint: 'https://push.example/sub', p256dh: 'key', auth: 'auth' }]), sendToAllSubscriptions: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0, quarantined: 0, errors: [], failedSubscriptionIds: [] })) }));
beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { vi.clearAllMocks(); await reset(); });
const id = '11111111-1111-4111-8111-111111111111';
const due = '2099-01-02T10:00:00.000Z';
const note = `- [ ] Old title ${due} <!-- crate-id:${id} -->`;
const PATH = 'Reminders/Inbox.md';

async function setup() {
	await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: null }) }), env.DB);
	const first = await writeCommittedMarkdownFile(env.BUCKET, env.DB, PATH, note, null);
	await drainNotificationProjections(env);
	return first;
}
/** Brings the scheduled attempt forward; the occurrence itself stays in the future. */
const makeDue = () => env.DB.prepare('UPDATE reminder_projections SET due_at = ? WHERE due_at IS NOT NULL').bind(Date.now()).run();
const row = () => env.DB.prepare(`SELECT file_path, due_datetime, content, due_at, attempts, pending_subscriptions, delivered_due, delivery_failed_at
  FROM reminder_projections WHERE reminder_id = ?`).bind(id).first<Record<string, unknown>>();
async function edit(content: string, hash: string) {
	return writeCommittedMarkdownFile(env.BUCKET, env.DB, PATH, content, hash);
}

it('schedules the projected occurrence in the projection row itself', async () => {
	await setup();
	expect(await row()).toMatchObject({ file_path: PATH, due_datetime: due, content: 'Old title', due_at: Date.parse(due), attempts: 0, delivered_due: null });
});

it.each(['complete', 'change title'])('withholds delivery after a commit until its projection runs (%s)', async action => {
	const first = await setup();
	await edit(action === 'complete' ? note.replace('[ ]', '[x]') : note.replace('Old title', 'New title'), first.hash);
	await makeDue();
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).not.toHaveBeenCalled();
	// The fenced attempt waits within its retry budget instead of being dropped.
	expect(await row()).toMatchObject({ due_datetime: due, attempts: 1 });
	await drainNotificationProjections(env);
	if (action === 'complete') {
		expect(await row()).toMatchObject({ due_datetime: null, due_at: null });
		return;
	}
	await makeDue();
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: 'New title', tag: `${id}:${due}` }), expect.anything());
});

it('does not deliver an occurrence twice when it is cancelled and scheduled again', async () => {
	const first = await setup();
	await makeDue();
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).toHaveBeenCalledTimes(1);
	expect(await row()).toMatchObject({ due_at: null, delivered_due: due });
	const completed = await edit(note.replace('[ ]', '[x]'), first.hash);
	await drainNotificationProjections(env);
	await edit(note, completed.hash);
	await drainNotificationProjections(env);
	expect(await row()).toMatchObject({ due_datetime: due, due_at: null, delivered_due: due });
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).toHaveBeenCalledTimes(1);
});

it('does not deliver an occurrence twice when its reminder moves to another note', async () => {
	const first = await setup();
	await makeDue();
	await deliverDueReminders(env);
	// Leaving the note detaches the row with its delivered occurrence.
	await edit('# Empty', first.hash);
	await drainNotificationProjections(env);
	expect(await row()).toMatchObject({ file_path: null, due_at: null, delivered_due: due });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Other.md', note, null);
	await drainNotificationProjections(env);
	expect(await row()).toMatchObject({ file_path: 'Reminders/Other.md', due_datetime: due, due_at: null, delivered_due: due });
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).toHaveBeenCalledTimes(1);
});

it('removes a detached occurrence once its delivery window has passed', async () => {
	const first = await setup();
	await env.DB.prepare("INSERT INTO reminder_projections(reminder_id, file_path, delivered_due) VALUES ('old', NULL, '2000-01-01T00:00:00.000Z')").run();
	await edit('# Empty', first.hash);
	await drainNotificationProjections(env);
	expect(await env.DB.prepare('SELECT reminder_id FROM reminder_projections').all()).toMatchObject({ results: [] });
});

it('reports exhausted delivery without rearming the same occurrence', async () => {
	await setup();
	await makeDue();
	await env.DB.prepare('UPDATE reminder_projections SET attempts = 10').run();
	vi.mocked(sendToAllSubscriptions).mockResolvedValueOnce({ sent: 0, failed: 1, pruned: 0, quarantined: 0, errors: ['provider unavailable'], failedSubscriptionIds: ['sub'] });
	expect(await deliverDueReminders(env)).toBeNull();
	expect(await row()).toMatchObject({ due_at: null, attempts: 10, delivery_failed_at: expect.any(String) as string });
	const diagnostics: unknown = await (await handleDiagnostics(env.DB)).json();
	expect(diagnostics).toMatchObject({ status: 'ok', counts: { scheduledReminders: 0, pendingNotificationJobs: 0, pendingNotificationProjections: 0, failedNotificationProjections: 0, failedNotificationDeliveries: 1 } });
});

it('retries only the recipients that failed', async () => {
	await setup();
	await makeDue();
	vi.mocked(sendToAllSubscriptions).mockResolvedValueOnce({ sent: 1, failed: 1, pruned: 0, quarantined: 0, errors: ['offline'], failedSubscriptionIds: ['sub'] });
	const next = await deliverDueReminders(env);
	expect(await row()).toMatchObject({ attempts: 1, pending_subscriptions: '["sub"]' });
	expect(next).toBeGreaterThan(Date.now() + 50_000);
	await makeDue();
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ subscriptionIds: ['sub'] }));
	expect(await row()).toMatchObject({ due_at: null, attempts: 0, pending_subscriptions: null, delivered_due: due });
});

it('delivers the updated title only after its projection commits', async () => {
	const first = await setup();
	await edit(note.replace('Old title', 'Current title'), first.hash);
	await makeDue();
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).not.toHaveBeenCalled();
	await drainNotificationProjections(env);
	await makeDue();
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
	expect(sendToAllSubscriptions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: 'Current title' }), expect.anything());
});

it('retains completion when the same occurrence is reprojected during delivery', async () => {
	const first = await setup();
	await makeDue();
	let started!: () => void;
	const sending = new Promise<void>(resolve => { started = resolve; });
	let finish!: () => void;
	vi.mocked(sendToAllSubscriptions).mockImplementationOnce(async () => {
		started();
		await new Promise<void>(resolve => { finish = resolve; });
		return { sent: 1, failed: 0, pruned: 0, quarantined: 0, errors: [], failedSubscriptionIds: [] };
	});
	const delivery = deliverDueReminders(env);
	await sending;
	await edit(note.replace('Old title', 'Current title'), first.hash);
	await drainNotificationProjections(env);
	finish();
	await delivery;
	expect(await row()).toMatchObject({ content: 'Current title', due_at: null, delivered_due: due });
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).toHaveBeenCalledOnce();
});

it.each([false, true])('preserves a new occurrence when an old delivery finishes (failed=%s)', async failed => {
	const first = await setup();
	await makeDue();
	let started!: () => void;
	const sending = new Promise<void>(resolve => { started = resolve; });
	let finish!: () => void;
	const finished = new Promise<void>(resolve => { finish = resolve; });
	vi.mocked(sendToAllSubscriptions).mockImplementationOnce(async () => {
		started();
		await finished;
		return { sent: failed ? 0 : 1, failed: failed ? 1 : 0, pruned: 0, quarantined: 0,
			errors: failed ? ['offline'] : [], failedSubscriptionIds: failed ? ['sub'] : [] };
	});
	const delivery = deliverDueReminders(env);
	await sending;
	const nextDue = '2099-02-01T10:00:00.000Z';
	try {
		await edit(note.replace('Old title', 'Next occurrence').replace(due, nextDue), first.hash);
		await drainNotificationProjections(env);
	} finally {
		finish();
		await delivery;
	}
	expect(await row()).toMatchObject({ due_datetime: nextDue, content: 'Next occurrence', due_at: Date.parse(nextDue),
		attempts: 0, pending_subscriptions: null, delivery_failed_at: null, delivered_due: failed ? null : due });

	await makeDue();
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).toHaveBeenCalledTimes(2);
	expect(sendToAllSubscriptions).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ title: 'Next occurrence', tag: `${id}:${nextDue}` }),
		expect.objectContaining({ subscriptionIds: undefined }));
	expect(await row()).toMatchObject({ due_at: null, delivered_due: nextDue });
});

it('does not clear a terminal failure when the same occurrence is reprojected', async () => {
	const first = await setup();
	await makeDue();
	await env.DB.prepare('UPDATE reminder_projections SET attempts = 10').run();
	vi.mocked(sendToAllSubscriptions).mockResolvedValueOnce({ sent: 0, failed: 1, pruned: 0, quarantined: 0, errors: ['offline'], failedSubscriptionIds: ['sub'] });
	await deliverDueReminders(env);
	await edit(note.replace('Old title', 'Edited title'), first.hash);
	await drainNotificationProjections(env);
	expect(await row()).toMatchObject({ content: 'Edited title', due_at: null, delivery_failed_at: expect.any(String) as string });
	expect(await (await handleDiagnostics(env.DB)).json()).toMatchObject({ counts: { failedNotificationDeliveries: 1 }, oldestNotificationFailureAt: expect.any(String) as string });
});

it('fails an occurrence that missed its 24-hour delivery window', async () => {
	await setup();
	await env.DB.prepare("UPDATE reminder_projections SET due_datetime = '2000-01-01T00:00:00.000Z', due_at = 1").run();
	await deliverDueReminders(env);
	expect(sendToAllSubscriptions).not.toHaveBeenCalled();
	expect(await row()).toMatchObject({ due_at: null, delivery_failed_at: expect.any(String) as string });
});
