import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { applyConfigFromUrl } from '../config';
import type { StoredConfig } from '../types';

const exchange = vi.hoisted(() => vi.fn<(token: string, previous: string | null) => Promise<string>>());
const redeemed = vi.hoisted(() => new Set<string>());
vi.mock('./enrollment-exchange', () => ({ exchangeEnrollmentToken: exchange }));
vi.mock('../shell/device', () => ({ isStandaloneApp: () => false }));
vi.mock('./install-enrollment', () => ({
	enrollmentFingerprint: async (token: string) => `fp-${token}`,
	wasEnrollmentRedeemed: (fingerprint: string) => redeemed.has(fingerprint),
	rememberRedeemedEnrollment: (fingerprint: string) => { redeemed.add(fingerprint); },
}));

const { redeemLaunchEnrollment } = await import('./launch-enrollment');
const { AUTH_TOKEN_KEY } = await import('../config');

const stored: StoredConfig = { folderPath: 'Old', upcomingDays: 7, allDayNotificationTime: null };
const linked: StoredConfig = { folderPath: 'New', upcomingDays: 7, allDayNotificationTime: null };
const launch = (token: string | null): ReturnType<typeof applyConfigFromUrl> => ({ config: linked, token, project: null, tab: null, reminderId: null });
let storage: Map<string, string>;
const events: string[] = [];

function run(overrides: Partial<Parameters<typeof redeemLaunchEnrollment>[0]> = {}) {
	const session = { current: () => true };
	const options = {
		applied: launch('grant'), storedConfig: stored, authToken: null, session, cancelled: () => false,
		suspendLocalSession: vi.fn(async () => { storage.delete(AUTH_TOKEN_KEY); }), showToast: vi.fn(), ...overrides,
	};
	return { options, result: redeemLaunchEnrollment(options) };
}

beforeEach(() => {
	storage = new Map(); redeemed.clear(); events.length = 0; exchange.mockReset();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => { storage.set(key, value); },
		removeItem: (key: string) => { storage.delete(key); },
	});
	vi.stubGlobal('window', { dispatchEvent: (event: Event) => { events.push(event.type); return true; } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('redeemLaunchEnrollment', () => {
	it('keeps the stored folder for a signed-in launch without a grant', async () => {
		const { result } = run({ applied: launch(null), authToken: 'existing' });
		expect(await result).toEqual({ token: 'existing', config: stored, enrollmentFailed: false, redeemed: false });
		expect(exchange).not.toHaveBeenCalled();
	});

	it('uses the link folder for a first launch without a grant', async () => {
		expect(await run({ applied: launch(null) }).result).toEqual({ token: null, config: linked, enrollmentFailed: false, redeemed: false });
	});

	it('ignores a spent grant and its folder', async () => {
		redeemed.add('fp-grant');
		expect(await run({ authToken: 'existing' }).result).toEqual({ token: 'existing', config: stored, enrollmentFailed: false, redeemed: false });
		expect(exchange).not.toHaveBeenCalled();
	});

	it('redeems a grant, clears the old local session and publishes the new credential', async () => {
		exchange.mockResolvedValue('fresh');
		const { options, result } = run({ authToken: 'existing' });
		expect(await result).toEqual({ token: 'fresh', config: linked, enrollmentFailed: false, redeemed: true });
		expect(exchange).toHaveBeenCalledWith('grant', 'existing');
		expect(options.suspendLocalSession).toHaveBeenCalledOnce();
		expect(storage.get(AUTH_TOKEN_KEY)).toBe('fresh');
		expect(JSON.parse(storage.get('crate-reminders-config')!)).toEqual(linked);
		expect(events).toEqual(['crate-reminders-auth-change']);
		expect(redeemed.has('fp-grant')).toBe(true);
		// The fence now tracks the redeemed session.
		expect(options.session.current()).toBe(true);
		storage.set(AUTH_TOKEN_KEY, 'other-tab');
		expect(options.session.current()).toBe(false);
	});

	it('keeps an existing session when its replacement link fails', async () => {
		exchange.mockRejectedValue(new Error('expired'));
		const { options, result } = run({ authToken: 'existing' });
		expect(await result).toEqual({ token: 'existing', config: stored, enrollmentFailed: true, redeemed: false });
		expect(options.showToast).toHaveBeenCalledWith('error', 'Could not reconnect: expired');
		expect(options.suspendLocalSession).not.toHaveBeenCalled();
		expect(redeemed.size).toBe(0);
	});

	it('fails a first enrollment whose link is rejected', async () => {
		exchange.mockRejectedValue(new Error('expired'));
		await expect(run().result).rejects.toThrow('expired');
	});

	it('stops when the launch is cancelled or its session is replaced', async () => {
		exchange.mockResolvedValue('fresh');
		expect(await run({ cancelled: () => true }).result).toBeNull();
		let current = true;
		exchange.mockImplementation(async () => { current = false; storage.set(AUTH_TOKEN_KEY, 'other-tab'); return 'fresh'; });
		expect(await run({ session: { current: () => current } }).result).toBeNull();
		expect(storage.get(AUTH_TOKEN_KEY)).toBe('other-tab');
	});
});
