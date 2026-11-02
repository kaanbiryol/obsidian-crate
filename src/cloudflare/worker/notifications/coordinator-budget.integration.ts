/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleNotificationPolicy } from './policy';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { runNotificationCoordinator } from './coordinator';
import { dispatchNotificationJobs } from './outbox';
import { armNotificationCoordinator } from './lifecycle';
import { runCoordinatorAlarm } from '../coordinator/coordinator-alarms';
import { installD1QueryCounter } from '../test-support/d1-query-test-harness';
import { D1_QUERIES_PER_INVOCATION } from '../d1/platform-limits';
import { REMINDER_CACHE_PARSER_VERSION } from '../reminders/cache/types';

// Delivery runs in its own Durable Object invocation with a separate budget.
vi.mock('./outbox', async original => ({ ...await original<typeof import('./outbox')>(), dispatchNotificationJobs: vi.fn() }));

beforeEach(async () => {
	await applySchema(env.DB);
	await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00' }) }), env.DB);
});
afterEach(async () => { vi.mocked(dispatchNotificationJobs).mockClear(); await reset(); });

async function countQueries(run: () => Promise<unknown>): Promise<{ total: number; setup: number }> {
	const count = installD1QueryCounter(env.DB);
	const prepare = vi.spyOn(env.DB, 'prepare');
	try {
		await run();
		const setup = prepare.mock.calls.filter(([sql]) => sql.includes('FROM notification_policy WHERE id = 1') || sql.includes('FROM server_state WHERE id = 1')).length;
		return { total: count.queries, setup };
	} finally { vi.restoreAllMocks(); }
}

it('reads encryption, feature and notification settings once per coordinator run', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', `- [ ] Task 2099-01-01T12:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`, null);
	const state = { storage: { setAlarm: vi.fn(async () => {}) } } as unknown as DurableObjectState;
	// Before, counted in statements: 31 with 8 setup reads, then 16 with 7. Encryption, features,
	// the import state and the notification policy now share one read. A due dispatch
	// is reported to the alarm, which sends it after releasing the coordinator lock.
	let due: boolean | undefined;
	expect(await countQueries(async () => { due = await runNotificationCoordinator(state, env); })).toEqual({ total: 18, setup: 1 });
	expect(due).toBe(true);
	expect(await countQueries(() => runNotificationCoordinator(state, env))).toEqual({ total: 9, setup: 1 });
	expect(await env.DB.prepare('SELECT COUNT(*) AS jobs FROM notification_jobs').first()).toEqual({ jobs: 1 });
	expect(dispatchNotificationJobs).not.toHaveBeenCalled();
});

it('verifies and projects eight files per pass, reading each once, within the query budget', async () => {
	for (let file = 0; file < 9; file++) {
		const content = Array.from({ length: 3 }, () => `- [ ] Task 2099-01-01T12:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`).join('\n');
		await writeCommittedMarkdownFile(env.BUCKET, env.DB, `Reminders/${file}.md`, content, null);
	}
	await env.DB.prepare("INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, 1, 'Reading', 'g', 'r')").run();
	for (let note = 0; note < 3; note++) await writeCommittedMarkdownFile(env.BUCKET, env.DB, `Reading/${note}.md`, `# Note ${note}`, null);
	// Worst case: every source needs the current parser, every projection succeeds and
	// the Reading index rebuilds a page in the same pass.
	await env.DB.batch([
		env.DB.prepare('UPDATE reminder_source_state SET parser_version = 0, verified = 0'),
		env.DB.prepare('DELETE FROM reading_index'),
	]);
	const state = { storage: { setAlarm: vi.fn(async () => {}) } } as unknown as DurableObjectState;
	const get = vi.spyOn(env.BUCKET, 'get');
	const { total } = await countQueries(() => runNotificationCoordinator(state, env));
	expect(total).toBe(39);
	// Projection reuses the bytes verification read: one read per reminder and Reading note.
	expect(get).toHaveBeenCalledTimes(8 + 3);
	expect(total).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_source_state WHERE verified = 1 AND parser_version = ?')
		.bind(REMINDER_CACHE_PARSER_VERSION).first()).toEqual({ n: 8 });
	expect(await env.DB.prepare('SELECT COUNT(DISTINCT file_path) AS n FROM reminder_projections').first()).toEqual({ n: 8 });
});

it('skips the dispatcher when no alarm update is due', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', `- [ ] Task 2099-01-01T12:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`, null);
	const setAlarm = vi.fn(async (_time: number) => {});
	const state = { storage: { setAlarm } } as unknown as DurableObjectState;
	await runNotificationCoordinator(state, env);
	const retryAt = Date.now() + 60_000;
	await env.DB.prepare('UPDATE notification_jobs SET available_at = ?').bind(retryAt).run();
	// An idle pass reads the queue head once and does not wake the dispatcher.
	let due: boolean | undefined;
	expect(await countQueries(async () => { due = await runNotificationCoordinator(state, env); })).toEqual({ total: 9, setup: 1 });
	expect(due).toBe(false);
	expect(setAlarm).toHaveBeenLastCalledWith(retryAt);
});

function coordinatorAlarm() {
	const values = new Map<string, unknown>();
	let alarm: number | null = null, locked = false;
	const storage = {
		get: async (key: string) => values.get(key),
		put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
		setAlarm: async (time: number) => { alarm = time; },
		deleteAlarm: async () => { alarm = null; },
	};
	const state = { storage } as unknown as DurableObjectState;
	const withStateLock = async <T>(action: () => Promise<T>) => { locked = true; try { return await action(); } finally { locked = false; } };
	return { state, values, alarm: () => alarm, locked: () => locked, run: () => runCoordinatorAlarm(state, env, withStateLock) };
}

it('dispatches due schedules after releasing the coordinator lock', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', `- [ ] Task 2099-01-01T12:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`, null);
	const coordinator = coordinatorAlarm();
	await armNotificationCoordinator(coordinator.state);
	let lockedDuringDispatch: boolean | undefined;
	vi.mocked(dispatchNotificationJobs).mockImplementationOnce(async () => { lockedDuringDispatch = coordinator.locked(); });
	expect(await coordinator.run()).toBe(true);
	expect(lockedDuringDispatch).toBe(false);
	// The locked pass armed the next one, which checks for more due schedules.
	expect(coordinator.alarm()).toBeLessThanOrEqual(Date.now() + 1);
	expect(coordinator.values.get('notificationRun')).toMatchObject({ passes: 1, failures: 0 });
});

it('counts a failed dispatch against its episode unless a change started a new one', async () => {
	const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', `- [ ] Task 2099-01-01T12:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`, null);
	const coordinator = coordinatorAlarm();
	await armNotificationCoordinator(coordinator.state);
	vi.mocked(dispatchNotificationJobs).mockRejectedValueOnce(new Error('dispatcher unavailable'));
	await coordinator.run();
	expect(coordinator.values.get('notificationRun')).toMatchObject({ passes: 1, failures: 1 });
	expect(coordinator.alarm()).toBeGreaterThan(Date.now() + 50_000);
	// A change committed while the dispatch was in flight keeps its fresh budget and immediate pass.
	vi.mocked(dispatchNotificationJobs).mockImplementationOnce(async () => {
		await armNotificationCoordinator(coordinator.state);
		throw new Error('dispatcher unavailable');
	});
	await coordinator.run();
	expect(coordinator.values.get('notificationRun')).toMatchObject({ passes: 0, failures: 0 });
	expect(coordinator.alarm()).toBeLessThanOrEqual(Date.now() + 1);
	logged.mockRestore();
});
