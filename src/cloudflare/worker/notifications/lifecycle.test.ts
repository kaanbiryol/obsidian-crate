import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { armNotificationCoordinator, runBoundedNotificationCoordinator, SOURCE_SCAN_DAILY_WRITE_BUDGET } from './lifecycle';
import { runNotificationCoordinator } from './coordinator';
vi.mock('./coordinator', () => ({ runNotificationCoordinator: vi.fn() }));

function fixture() {
	const values = new Map<string, unknown>();
	const storage = {
		get: vi.fn(async (key: string) => values.get(key)),
		put: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }),
		setAlarm: vi.fn(async (_time: number) => {}),
		deleteAlarm: vi.fn(async () => {}),
	};
	return { values, storage, state: { storage } as never };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(runNotificationCoordinator).mockResolvedValue({ wrote: false, dispatchAt: undefined }); });

it('persists its processing budget and alarm before accepting work', async () => {
	const { state, values, storage } = fixture();
	await armNotificationCoordinator(state);
	expect(values.get('projectionCoordinator')).toBe(true);
	expect(values.get('notificationRun')).toMatchObject({ passes: 0, failures: 0 });
	expect(storage.setAlarm).toHaveBeenCalledOnce();
	expect(storage.put.mock.invocationCallOrder[1]).toBeLessThan(storage.setAlarm.mock.invocationCallOrder[0]!);
});

it('stops after eight coordinator failures instead of retrying forever', async () => {
	const { state, storage } = fixture();
	vi.mocked(runNotificationCoordinator).mockRejectedValue(new Error('database unavailable'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	await armNotificationCoordinator(state);
	storage.setAlarm.mockClear();
	for (let i = 0; i < 12; i++) await runBoundedNotificationCoordinator(state, {} as never);
	expect(runNotificationCoordinator).toHaveBeenCalledTimes(8);
	expect(storage.setAlarm).toHaveBeenCalledTimes(7);
	expect(storage.deleteAlarm).toHaveBeenCalled();
});

it('keeps counting passes toward the limit after the object is evicted', async () => {
	const { state, values } = fixture();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	await armNotificationCoordinator(state);
	for (let i = 0; i < 9_999; i++) await runBoundedNotificationCoordinator(state, {} as never);
	expect(values.get('notificationRun')).toMatchObject({ passes: 9_500 });
	// A new activation reads the stored count and stops at the limit, not 10,000 passes later.
	const evicted = { storage: (state as { storage: object }).storage } as never;
	for (let i = 0; i < 600; i++) await runBoundedNotificationCoordinator(evicted, {} as never);
	expect(runNotificationCoordinator).toHaveBeenCalledTimes(9_999 + 500);
});

it.each([
	{ startedAt: Date.now() - 86400_001, passes: 1, failures: 0 },
	{ startedAt: Date.now(), passes: 10_000, failures: 0 },
])('stops an exhausted episode and allows a subsequent change to resume it', async run => {
	const { state, values, storage } = fixture();
	values.set('notificationRun', run);
	await runBoundedNotificationCoordinator(state, {} as never);
	expect(runNotificationCoordinator).not.toHaveBeenCalled();
	expect(storage.deleteAlarm).toHaveBeenCalledOnce();
	await armNotificationCoordinator(state);
	await runBoundedNotificationCoordinator(state, {} as never);
	expect(runNotificationCoordinator).toHaveBeenCalledOnce();
});

it('does not add a timer when the coordinator finishes idle', async () => {
	const { state, storage } = fixture();
	await runBoundedNotificationCoordinator(state, {} as never);
	expect(storage.setAlarm).not.toHaveBeenCalled();
});

it('waits for the D1 daily reset without spending its failure budget', async () => {
	const { state, values, storage } = fixture();
	vi.mocked(runNotificationCoordinator).mockRejectedValue(new Error('D1_ERROR: Exceeded daily rows written limit'));
	vi.spyOn(console, 'error').mockImplementation(() => {});
	await armNotificationCoordinator(state);
	storage.setAlarm.mockClear();
	await runBoundedNotificationCoordinator(state, {} as never);
	const midnight = (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000;
	const [resume] = storage.setAlarm.mock.calls[0]!;
	expect(resume).toBeGreaterThanOrEqual(midnight);
	expect(resume).toBeLessThan(midnight + 600_000);
	expect(values.get('notificationRun')).toEqual({ startedAt: resume, passes: 0, failures: 0 });
	expect(storage.deleteAlarm).not.toHaveBeenCalled();
});

it('wakes the dispatcher after a pass that failed once it may have committed a schedule', async () => {
	const { state } = fixture();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	await armNotificationCoordinator(state);
	// The pass committed a schedule, then a later query failed: its `wrote` is lost.
	vi.mocked(runNotificationCoordinator).mockRejectedValueOnce(new Error('database unavailable'));
	expect(await runBoundedNotificationCoordinator(state, {} as never)).toBeNull();
	// The retry finds no job for the committed file, so it writes nothing, but reports the due time.
	vi.mocked(runNotificationCoordinator).mockResolvedValueOnce({ wrote: false, dispatchAt: 1_000 });
	expect(await runBoundedNotificationCoordinator(state, {} as never)).toMatchObject({ dispatchAt: 1_000 });
});

it('pauses the bulk source scan until the next UTC day once today\'s write budget is spent', async () => {
	// The Free plan's daily quota applies to Cloudflare builds only.
	const flags = globalThis as { __CRATE_SELF_HOSTED__?: boolean };
	flags.__CRATE_SELF_HOSTED__ = false;
	onTestFinished(() => { flags.__CRATE_SELF_HOSTED__ = true; });
	const { state, values } = fixture();
	await armNotificationCoordinator(state);
	const today = Math.floor(Date.now() / 86_400_000);
	values.set('notificationDailyWrites', { day: today, rowsWritten: SOURCE_SCAN_DAILY_WRITE_BUDGET });
	await runBoundedNotificationCoordinator(state, {} as never);
	const paused = vi.mocked(runNotificationCoordinator).mock.calls[0]![2]!.sourceScanPausedUntil!;
	expect(paused).toBeGreaterThanOrEqual((today + 1) * 86_400_000);
	// A count from an earlier day does not hold the scan back.
	values.set('notificationDailyWrites', { day: today - 1, rowsWritten: SOURCE_SCAN_DAILY_WRITE_BUDGET });
	await runBoundedNotificationCoordinator(state, {} as never);
	expect(vi.mocked(runNotificationCoordinator).mock.calls[1]![2]).toEqual({ sourceScanPausedUntil: undefined });
});

it('keeps resuming a source scan that needs several daily write budgets', async () => {
	const flags = globalThis as { __CRATE_SELF_HOSTED__?: boolean };
	flags.__CRATE_SELF_HOSTED__ = false;
	vi.useFakeTimers({ now: Date.UTC(2026, 10, 10, 10) });
	onTestFinished(() => { flags.__CRATE_SELF_HOSTED__ = true; vi.useRealTimers(); });
	const { state, values, storage } = fixture();
	await armNotificationCoordinator(state);
	const spendToday = () => values.set('notificationDailyWrites', { day: Math.floor(Date.now() / 86_400_000), rowsWritten: SOURCE_SCAN_DAILY_WRITE_BUDGET });
	spendToday();
	await runBoundedNotificationCoordinator(state, {} as never);
	vi.setSystemTime(Date.UTC(2026, 10, 11, 0, 5));
	spendToday();
	await runBoundedNotificationCoordinator(state, {} as never);
	// Two days into the scan, the next day's pass still runs instead of ending the episode.
	vi.setSystemTime(Date.UTC(2026, 10, 12, 0, 5));
	await runBoundedNotificationCoordinator(state, {} as never);
	expect(runNotificationCoordinator).toHaveBeenCalledTimes(3);
	expect(vi.mocked(runNotificationCoordinator).mock.calls[2]![2]).toEqual({ sourceScanPausedUntil: undefined });
	expect(storage.deleteAlarm).not.toHaveBeenCalled();
});
