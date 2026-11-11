/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { featurePolicy } from './feature-policy';
import { handleFeaturePolicy } from './feature-policy-handler';
import { handleReadingRoute } from '../test-support/reading-route-test-harness';
import { createReadingNote } from '@/reading/core/notes';
import type { PendingCapture } from '../reading/captures';
import { publishExtraction, type Publication } from '../reading/extraction/jobs';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../sync/markdown-files';
import { handleNotificationPolicy } from '../notifications/policy';
import { drainNotificationProjections } from '../notifications/projection';
import { armReminderDispatcher } from '../coordinator/coordinator';
import { handleAuthenticatedRoute, isAuthenticatedRouteAllowed } from '../router';
import { authenticateWorkerRequest } from '../auth/authenticate';
import { sha256Hex } from '@/platform/sha256';
beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
});
afterEach(async () => { vi.clearAllMocks(); await reset(); });
const req = (path: string, body: unknown) => new Request(`https://test/${path}`, { method: 'POST', body: JSON.stringify(body) });
const reading = (path: string, body: Record<string, unknown>) => handleReadingRoute(req(`reading/${path}`, body), env, { tokenId: 'vault', scope: 'vault' });
async function toggle(feature: 'reading' | 'reminders', enabled: boolean) {
	const current = await featurePolicy(env.DB);
	const response = await handleFeaturePolicy(req('features', { feature, enabled, revision: current.revision }), env);
	expect(response.status, await response.clone().text()).toBe(200);
}
it('defaults on, rejects stale edits, and limits writes to vault credentials', async () => {
	expect(await featurePolicy(env.DB)).toEqual({ reading: true, reminders: true, revision: null });
	await toggle('reading', false);
	expect((await handleFeaturePolicy(req('features', { feature: 'reminders', enabled: false, revision: null }), env)).status).toBe(409);
	expect(await featurePolicy(env.DB)).toMatchObject({ reading: false, reminders: true });
	expect(isAuthenticatedRouteAllowed({ tokenId: 'browser', scope: 'reminders' }, '/features', 'GET')).toBe(true);
	expect(isAuthenticatedRouteAllowed({ tokenId: 'browser', scope: 'reminders' }, '/features', 'POST')).toBe(false);
	expect(isAuthenticatedRouteAllowed({ tokenId: 'shortcut', scope: 'reading_capture' }, '/features', 'GET')).toBe(false);
});
it('gates reminder routes on the feature policy loaded with the token', async () => {
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('device', ?)").bind(await sha256Hex('device-token')).run();
	await toggle('reminders', false);
	const request = new Request('https://test/reminders/list', { headers: { Authorization: 'Bearer device-token' } });
	const auth = await authenticateWorkerRequest(request, env.DB);
	if (auth.response) throw new Error('Authentication failed');
	expect(JSON.parse(auth.featurePolicyValue!)).toMatchObject({ reminders: false });
	const response = await handleAuthenticatedRoute(request, env, {
		uploadCommitters: {} as never, path: '/reminders/list', method: 'GET', principal: auth.principal,
		resetGeneration: auth.resetGeneration, encryption: null, featurePolicyValue: auth.featurePolicyValue,
	});
	expect(response?.status).toBe(423);
});
it('blocks capture and publication while paused and resumes the retained article job', async () => {
	await reading('policy', { enabled: true, folderPath: 'Reading', revision: null });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Article.md', createReadingNote({ id: crypto.randomUUID(), url: 'https://example.invalid/article', savedAt: new Date().toISOString() }), null);
	// The note's commit queued its article job.
	const job = (await env.DB.prepare('SELECT * FROM reading_jobs').first<Publication['job']>())!;
	const original = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path);
	await toggle('reading', false);
	expect((await reading('capture', { url: 'https://example.invalid/new', fetchArticle: true, operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)) })).status).toBe(423);
	const publication = { job, result: { markdown: 'Saved article text', title: 'Article', author: '', faviconUrl: '' } };
	await publishExtraction(env, publication);
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))?.content).toBe(original?.content);
	expect(await env.DB.prepare('SELECT 1 FROM reading_jobs').first()).not.toBeNull();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Ordinary.md', 'Sync still works.', null);
	await toggle('reading', true);
	await publishExtraction(env, publication);
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))?.content).toContain('Saved article text');
});
it('retains notification state while paused, rearms on resume, and never repeats a completed delivery', async () => {
	await handleNotificationPolicy(req('policy', { folderPath: 'Reminders', timezone: 'UTC', allDayTime: null, enabled: true }), env.DB);
	const id = '11111111-1111-4111-8111-111111111111';
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', `- [ ] Task @2099-01-02T10:00:00.000Z <!-- crate-id:${id} -->`, null);
	await drainNotificationProjections(env);
	const dispatcher = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/notification-dispatch'));
	const alarmTime = () => runInDurableObject(dispatcher, (_instance, state) => state.storage.getAlarm());
	expect(await armReminderDispatcher(env)).toBe(true);
	expect(await alarmTime()).toBe(Date.parse('2099-01-02T10:00:00.000Z'));
	await toggle('reminders', false);
	// Bring the attempt forward; the paused pass, which runs at once, sends nothing and leaves no alarm.
	await env.DB.prepare('UPDATE reminder_projections SET due_at = ?').bind(Date.now()).run();
	await runInDurableObject(dispatcher, (_instance, state) => state.storage.setAlarm(Date.now()));
	await vi.waitFor(async () => expect(await alarmTime()).toBeNull());
	expect(await env.DB.prepare('SELECT attempts, due_at IS NOT NULL AS scheduled, delivered_due FROM reminder_projections').first())
		.toEqual({ attempts: 0, scheduled: 1, delivered_due: null });
	expect(await env.DB.prepare('SELECT enabled FROM notification_policy').first()).toEqual({ enabled: 1 });
	// Resuming arms the dispatcher for the overdue attempt, which delivers it. The Durable
	// Object runs the bundled Worker, outside this file's push mock, with no recipients.
	await toggle('reminders', true);
	await vi.waitFor(async () => expect(await env.DB.prepare('SELECT due_at, delivered_due FROM reminder_projections').first())
		.toEqual({ due_at: null, delivered_due: '2099-01-02T10:00:00.000Z' }));
	// Pausing and resuming again leaves nothing to deliver, so no alarm is armed.
	await toggle('reminders', false); await toggle('reminders', true);
	expect(await alarmTime()).toBeNull();
	expect(await runDurableObjectAlarm(dispatcher)).toBe(false);
});


it('retains queued captures while paused and publishes them after resume', async () => {
	await reading('policy', { enabled: true, folderPath: 'Reading', revision: null });
	expect((await reading('capture', { url: 'https://example.invalid/queued', operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)) })).status).toBe(200);
	const capture = (await env.DB.prepare('SELECT * FROM reading_captures').first<PendingCapture>())!;
	await toggle('reading', false);
	await publishExtraction(env, { captureId: capture.id, generation: capture.generation, result: { markdown: 'Saved article text', title: 'Article' } });
	expect(await env.DB.prepare('SELECT * FROM reading_captures').first()).toEqual(capture);
	expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
	await toggle('reading', true);
	await publishExtraction(env, { captureId: capture.id, generation: capture.generation, result: { markdown: 'Saved article text', title: 'Article' } });
	expect(await env.DB.prepare('SELECT 1 FROM reading_captures').first()).toBeNull();
	const file = (await env.DB.prepare('SELECT path FROM files').first<{ path: string }>())!;
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, file.path))?.content).toContain('Saved article text');
});
