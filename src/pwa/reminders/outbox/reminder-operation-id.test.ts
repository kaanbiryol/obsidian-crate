import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newReminderOperationId, refreshReminderOperationDay } from './reminder-operation-id';
import { reminderOperationDay } from '@/protocol/reminder-operation';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol/server-info';
import { invalidatePwaSession } from '../../connection/session-generation';

const values = new Map<string, string>();
// Each test starts later than the shared server-info reuse window.
let clock = performance.now();
beforeEach(() => {
	values.clear();
	clock += 60_000;
	vi.spyOn(performance, 'now').mockImplementation(() => clock);
	vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function info(day?: number) {
	return new Response(JSON.stringify({ service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], reminderOperationDay: day }));
}
it.each(['2000-01-01', '2099-01-01'])('uses server dates when the device clock is %s', async date => {
	vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(date));
	vi.stubGlobal('fetch', vi.fn(async () => info(20_000)));
	const first = await newReminderOperationId();
	expect(reminderOperationDay(first)).toBe(20_000);
	expect(await newReminderOperationId()).not.toBe(first);
});
it('refuses missing server dates and session changes instead of inventing a retry deadline', async () => {
	vi.stubGlobal('fetch', vi.fn(async () => info()));
	await expect(newReminderOperationId()).rejects.toThrow('Update');
	clock += 10_000;
	vi.stubGlobal('fetch', vi.fn(async () => { invalidatePwaSession(); return info(20_000); }));
	await expect(newReminderOperationId()).rejects.toThrow('Session changed');
});
it('issues IDs from a recently confirmed day without waiting on the server', async () => {
	vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
	const network = vi.fn(async () => info(20_000));
	vi.stubGlobal('fetch', network);
	refreshReminderOperationDay();
	await vi.waitFor(() => expect(values.size).toBe(1));
	// Before: every save waited on a fresh server-info request, so a stalled network held the editor open.
	network.mockImplementation(() => new Promise<Response>(() => {}));
	clock += 60_000;
	vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
	expect(reminderOperationDay(await newReminderOperationId())).toBe(20_000);
	expect(network).toHaveBeenCalledOnce();
});
it.each([['a week has passed', '2026-11-02T12:00:01Z'], ['the device clock moved back', '2026-10-26T11:59:59Z']])('fetches the day again when %s', async (_reason, later) => {
	vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
	const network = vi.fn(async () => info(20_000));
	vi.stubGlobal('fetch', network);
	await newReminderOperationId();
	clock += 60_000;
	vi.setSystemTime(new Date(later));
	network.mockImplementation(async () => info(20_007));
	expect(reminderOperationDay(await newReminderOperationId())).toBe(20_007);
	expect(network).toHaveBeenCalledTimes(2);
});
