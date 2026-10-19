import { afterEach, expect, it, vi } from 'vitest';
import { scheduleMaintenance } from './schedule';
import type { Env } from '../types';

afterEach(() => { vi.restoreAllMocks(); });

function maintenanceEnv(status = 204) {
	const fetch = vi.fn(async () => new Response(null, { status }));
	const env = { REMINDER_ALARMS: { idFromName: (name: string) => name, get: () => ({ fetch }) } } as unknown as Env;
	return { env, fetch };
}

it('confirms the cleanup alarm once per scope until the confirmation expires', async () => {
	const { env, fetch } = maintenanceEnv();
	const scope = {};
	const now = Date.now();
	vi.spyOn(Date, 'now').mockReturnValue(now);
	await scheduleMaintenance(env, scope);
	await scheduleMaintenance(env, scope);
	expect(fetch).toHaveBeenCalledOnce();
	await scheduleMaintenance(env, {});
	expect(fetch).toHaveBeenCalledTimes(2);
	vi.mocked(Date.now).mockReturnValue(now + 10 * 60 * 1000);
	await scheduleMaintenance(env, scope);
	expect(fetch).toHaveBeenCalledTimes(3);
});

it('does not remember a failed confirmation', async () => {
	const { env, fetch } = maintenanceEnv(500);
	const scope = {};
	await expect(scheduleMaintenance(env, scope)).rejects.toThrow('Unable to schedule server cleanup');
	await expect(scheduleMaintenance(env, scope)).rejects.toThrow('Unable to schedule server cleanup');
	expect(fetch).toHaveBeenCalledTimes(2);
});
