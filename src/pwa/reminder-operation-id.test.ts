import { afterEach, expect, it, vi } from 'vitest';
import { newReminderOperationId } from './reminder-operation-id';
import { reminderOperationDay } from '@/protocol/reminder-operation';
import { CRATE_PLUGIN_PROTOCOL } from '@/protocol';
import { invalidatePwaSession } from './session-generation';

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
	vi.stubGlobal('fetch', vi.fn(async () => { invalidatePwaSession(); return info(20_000); }));
	await expect(newReminderOperationId()).rejects.toThrow('Session changed');
});
