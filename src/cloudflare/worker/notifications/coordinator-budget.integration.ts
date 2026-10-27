/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleNotificationPolicy } from './policy';
import { writeCommittedMarkdownFile } from '../storage';
import { runNotificationCoordinator } from './coordinator';
import { dispatchNotificationJobs } from './outbox';

// Delivery runs in its own Durable Object invocation with a separate budget.
vi.mock('./outbox', async original => ({ ...await original<typeof import('./outbox')>(), dispatchNotificationJobs: vi.fn() }));

beforeEach(async () => {
	await applySchema(env.DB);
	await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00' }) }), env.DB);
});
afterEach(async () => { vi.mocked(dispatchNotificationJobs).mockClear(); await reset(); });

async function countStatements(run: () => Promise<void>): Promise<{ total: number; setup: number }> {
	const prepare = env.DB.prepare.bind(env.DB);
	let total = 0, setup = 0;
	env.DB.prepare = (sql: string) => {
		total += 1;
		if (sql.includes('FROM notification_policy WHERE id = 1') || sql.includes('FROM server_state WHERE id = 1')) setup += 1;
		return prepare(sql);
	};
	try { await run(); } finally { env.DB.prepare = prepare; }
	return { total, setup };
}

it('reads encryption, feature and notification settings once per coordinator run', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', `- [ ] Task 2099-01-01T12:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`, null);
	const state = { storage: { setAlarm: vi.fn(async () => {}) } } as unknown as DurableObjectState;
	// Before: 31 statements with 8 setup reads, then 16 with 7. Encryption, features,
	// the import state and the notification policy now share one read. Due dispatch
	// reads the queue head once more after the dispatcher drains it.
	expect(await countStatements(() => runNotificationCoordinator(state, env))).toEqual({ total: 24, setup: 1 });
	expect(await countStatements(() => runNotificationCoordinator(state, env))).toEqual({ total: 10, setup: 1 });
	expect(await env.DB.prepare('SELECT COUNT(*) AS jobs FROM notification_jobs').first()).toEqual({ jobs: 1 });
	expect(dispatchNotificationJobs).toHaveBeenCalledTimes(2);
	expect(dispatchNotificationJobs).toHaveBeenCalledWith(env, true);
});

it('skips the dispatcher when no alarm update is due', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', `- [ ] Task 2099-01-01T12:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`, null);
	const setAlarm = vi.fn(async (_time: number) => {});
	const state = { storage: { setAlarm } } as unknown as DurableObjectState;
	await runNotificationCoordinator(state, env);
	const retryAt = Date.now() + 60_000;
	await env.DB.prepare('UPDATE notification_jobs SET available_at = ?').bind(retryAt).run();
	vi.mocked(dispatchNotificationJobs).mockClear();
	// An idle pass reads the queue head once and does not wake the dispatcher.
	expect(await countStatements(() => runNotificationCoordinator(state, env))).toEqual({ total: 9, setup: 1 });
	expect(dispatchNotificationJobs).not.toHaveBeenCalled();
	expect(setAlarm).toHaveBeenLastCalledWith(retryAt);
});
