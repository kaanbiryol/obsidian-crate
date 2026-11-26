import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageGroup } from '../../cloudflare/usage/service';
import type { UsageWarning, UsageWarningState } from '../../cloudflare/usage/usage-warnings';
import { checkUsageWarnings, registerUsageWarnings } from './usage-warnings';

const DAY = 86_400_000;
const now = Date.parse('2026-11-26T10:00:00Z');
const storage = (used: number): UsageGroup[] => [{ label: 'Storage', metrics: [{ label: 'R2 storage', key: 'r2-storage', bytes: true, used, allowance: 10_000_000_000 }] }];

function setup({ checkedAt = now - DAY, connected = true, usageWarnings = true, state = null as UsageWarningState | null } = {}) {
	const settings = { usageWarnings, usageWarningState: state, cloudflareDeployment: { accountId: 'account' } };
	const login = {
		connected,
		needsAuthorization: false,
		snapshot: checkedAt ? { accountId: 'account', updatedAt: checkedAt, groups: [] } : null,
		fetchUsage: vi.fn(async () => storage(8_500_000_000)),
	};
	const writeSettings = vi.fn(async (update: { usageWarningState?: UsageWarningState | null }) => { Object.assign(settings, update); });
	const notices = { warn: vi.fn<(warnings: UsageWarning[]) => void>(), paused: vi.fn() };
	const host = { settings, cloudflareSavedLogin: login, writeSettings } as never;
	return { settings, login, writeSettings, notices, check: (at = now) => checkUsageWarnings(host, notices, new AbortController().signal, at), host };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('asks Cloudflare once a day and warns once per level', async () => {
	const { login, notices, settings, check } = setup({ checkedAt: now - DAY + 1 });
	expect(await check()).toBe(false);
	expect(login.fetchUsage).not.toHaveBeenCalled();
	expect(await check(now + 1)).toBe(true);
	expect(notices.warn).toHaveBeenCalledOnce();
	expect(notices.warn.mock.calls[0]![0][0]).toMatchObject({ level: 80, metric: { key: 'r2-storage' } });
	expect(settings.usageWarningState).toEqual({ month: '2026-11', shown: ['r2-storage:80'] });
	// The next day's check finds the same level and stays quiet.
	login.snapshot!.updatedAt = now;
	await check(now + DAY);
	expect(notices.warn).toHaveBeenCalledOnce();
});

it('stays off when turned off, without a saved sign-in, or for a self-hosted server', async () => {
	for (const options of [{ usageWarnings: false }, { connected: false }]) {
		const { login, check } = setup(options);
		expect(await check()).toBe(false);
		expect(login.fetchUsage).not.toHaveBeenCalled();
	}
	const selfHosted = setup();
	(selfHosted.settings as { cloudflareDeployment: unknown }).cloudflareDeployment = null;
	expect(await selfHosted.check()).toBe(false);
});

it('says once when an expired sign-in has stopped warnings for three days, then resets after a check', async () => {
	const { login, notices, settings, check } = setup({ checkedAt: now - 2 * DAY });
	login.fetchUsage.mockImplementation(async () => { login.needsAuthorization = true; throw new Error('expired'); });
	await check();
	expect(notices.paused).not.toHaveBeenCalled();
	await check(now + DAY);
	await check(now + DAY + 1);
	expect(notices.paused).toHaveBeenCalledOnce();
	expect(settings.usageWarningState).toMatchObject({ pausedShown: true });
	login.fetchUsage.mockResolvedValue(storage(0));
	login.needsAuthorization = false;
	await check(now + 2 * DAY);
	expect(settings.usageWarningState).toEqual({ month: '2026-11', shown: [] });
});

it('stays quiet when a check fails for another reason', async () => {
	const { login, notices, writeSettings, check } = setup({ checkedAt: now - 10 * DAY });
	login.fetchUsage.mockRejectedValue(new Error('offline'));
	expect(await check()).toBe(true);
	expect(notices.paused).not.toHaveBeenCalled();
	expect(writeSettings).not.toHaveBeenCalled();
});

describe('registration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		// Read through globalThis on each call, so the fake timers installed above apply.
		vi.stubGlobal('window', {
			setTimeout: (callback: () => void, delay?: number) => globalThis.setTimeout(callback, delay),
			clearTimeout: (id: number) => globalThis.clearTimeout(id),
			setInterval: (callback: () => void, delay?: number) => globalThis.setInterval(callback, delay),
			clearInterval: (id: number) => globalThis.clearInterval(id),
		});
	});

	it('checks after startup, retries a failure hours later, and stops on unload', async () => {
		const { login, host, notices } = setup();
		login.fetchUsage.mockRejectedValue(new Error('offline'));
		const controller = new AbortController();
		const intervals: number[] = [];
		registerUsageWarnings({ ...(host as object), registerInterval: (id: number) => { intervals.push(id); return id; } } as never, notices, controller.signal);
		await vi.advanceTimersByTimeAsync(59_000);
		expect(login.fetchUsage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(login.fetchUsage).toHaveBeenCalledOnce();
		// The hourly ticks before the six-hour retry only compare timestamps.
		await vi.advanceTimersByTimeAsync(6 * 3_600_000);
		expect(login.fetchUsage).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(login.fetchUsage).toHaveBeenCalledTimes(2);
		controller.abort();
		intervals.forEach(id => window.clearInterval(id));
		await vi.advanceTimersByTimeAsync(12 * 3_600_000);
		expect(login.fetchUsage).toHaveBeenCalledTimes(2);
	});
});
