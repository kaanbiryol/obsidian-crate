import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MAINTENANCE_DAILY_WRITE_BUDGET, runMaintenanceEpisode } from './lifecycle';
import { runScheduledMaintenance } from './run';
vi.mock('./run', () => ({ runScheduledMaintenance: vi.fn(async () => ({ removedObjects: 0, backlog: false })) }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture(advancing: 'queue' | 'lease' | null) {
	let cursor = 0;
	const values = new Map<string, unknown>();
	const storage = { get: async (key: string) => values.get(key),
		put: async (key: string, value: unknown) => { values.set(key, value); }, setAlarm: vi.fn() };
	const DB = { prepare: (sql: string) => ({ bind: () => ({ first: async () => null }),
		run: async () => ({ meta: { rows_read: 0, rows_written: Number(sql) } }), first: async () => {
		if (sql.includes('object_cleanup_queue')) return { storage_key: advancing === 'queue' ? String(cursor++) : 'unchanged' };
		return sql.includes('upload_leases') && advancing === 'lease' ? { id: String(cursor++), expires_at: 0 } : null;
	} }) };
	return { state: { storage } as never, env: { DB } as never, storage };
}
it('continues other advancing backlogs but stops after ten passes', async () => {
	const { state, env, storage } = fixture('lease');
	for (let pass = 0; pass < 12; pass++) await runMaintenanceEpisode(state, env);
	expect(runScheduledMaintenance).toHaveBeenCalledTimes(10);
	expect(storage.setAlarm).toHaveBeenCalledTimes(9);
});
it('keeps draining an advancing object cleanup queue up to 200 passes', async () => {
	const { state, env, storage } = fixture('queue');
	for (let pass = 0; pass < 202; pass++) await runMaintenanceEpisode(state, env);
	expect(runScheduledMaintenance).toHaveBeenCalledTimes(200);
	expect(storage.setAlarm).toHaveBeenCalledTimes(199);
});
it('does not retry a stuck backlog automatically', async () => {
	const { state, env, storage } = fixture(null);
	await runMaintenanceEpisode(state, env);
	expect(storage.setAlarm).not.toHaveBeenCalled();
});
it('continues a pruning backlog within the ten-pass episode budget', async () => {
	vi.mocked(runScheduledMaintenance).mockResolvedValue({ removedObjects: 0, backlog: true });
	const { state, env, storage } = fixture(null);
	for (let pass = 0; pass < 12; pass++) await runMaintenanceEpisode(state, env);
	expect(runScheduledMaintenance).toHaveBeenCalledTimes(10);
	expect(storage.setAlarm).toHaveBeenCalledTimes(9);
});

/** Each pass writes `rows` rows through the metered database it is given. */
function writing(rows: number) {
	vi.mocked(runScheduledMaintenance).mockImplementation(async env => {
		await env.DB.prepare(String(rows)).run();
		return { removedObjects: 0, backlog: true };
	});
}
const DAY = 86_400_000;

it('stops a backlog at the daily write budget and resumes it after the reset', async () => {
	// A Cloudflare server shares the Free plan's daily D1 writes.
	vi.stubGlobal('__CRATE_SELF_HOSTED__', false);
	vi.useFakeTimers({ now: 10 * DAY + 1000, toFake: ['Date'] });
	writing(8_000);
	const { state, env, storage } = fixture(null);
	for (let pass = 0; pass < 4; pass++) await runMaintenanceEpisode(state, env);
	expect(runScheduledMaintenance).toHaveBeenCalledTimes(3);
	const deferred = storage.setAlarm.mock.calls.at(-1)![0] as number;
	expect(deferred).toBeGreaterThanOrEqual(11 * DAY);
	expect(deferred).toBeLessThan(11 * DAY + 600_000);
	// A deferred wake does not use up the episode's passes.
	expect(await storage.get('maintenancePass')).toBe(3);
	vi.setSystemTime(11 * DAY + 1000);
	await runMaintenanceEpisode(state, env);
	expect(runScheduledMaintenance).toHaveBeenCalledTimes(4);
	expect(await storage.get('maintenanceDailyWrites')).toEqual({ day: 11, rowsWritten: 8_000 });
});

it('keeps a self-hosted backlog going past the Cloudflare daily write budget', async () => {
	vi.useFakeTimers({ now: 10 * DAY + 1000, toFake: ['Date'] });
	writing(8_000);
	const { state, env } = fixture(null);
	for (let pass = 0; pass < 4; pass++) await runMaintenanceEpisode(state, env);
	expect(runScheduledMaintenance).toHaveBeenCalledTimes(4);
});

it('waits for the daily reset when D1 reports its limit', async () => {
	vi.useFakeTimers({ now: 10 * DAY + 1000, toFake: ['Date'] });
	vi.mocked(runScheduledMaintenance).mockRejectedValueOnce(new Error('D1_ERROR: Exceeded daily limit of rows written'));
	const { state, env, storage } = fixture(null);
	await expect(runMaintenanceEpisode(state, env)).resolves.toBeUndefined();
	expect(storage.setAlarm).toHaveBeenCalledWith(expect.any(Number));
	expect(storage.setAlarm.mock.calls[0]![0]).toBeGreaterThanOrEqual(11 * DAY);
	expect(await storage.get('maintenancePass')).toBe(0);
	expect(await storage.get('maintenanceDailyWrites')).toEqual({ day: 10, rowsWritten: MAINTENANCE_DAILY_WRITE_BUDGET });
});

it('still fails a pass for other errors so the alarm retries', async () => {
	vi.mocked(runScheduledMaintenance).mockRejectedValueOnce(new Error('network'));
	const { state, env } = fixture(null);
	await expect(runMaintenanceEpisode(state, env)).rejects.toThrow('network');
});
