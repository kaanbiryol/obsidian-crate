import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearInstallEnrollment,
	enrollmentFingerprint,
	preserveInstallEnrollment,
	rememberRedeemedEnrollment,
	restoreInstallEnrollment,
	wasEnrollmentRedeemed,
} from './install-enrollment';

beforeEach(() => {
	vi.stubGlobal('window', { location: { protocol: 'https:' } });
	vi.stubGlobal('document', { cookie: '' });
	const stored = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value),
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('Home Screen enrollment transfer', () => {
	it('copies only the one-time install grant and launch settings into a bounded secure cookie', () => {
		preserveInstallEnrollment('https://worker.test/notifications?token=install&browserToken=browser&folder=Tasks&tab=inbox&reminderId=private&unrelated=ignored');
		expect(document.cookie).toBe('crate-reminders-install=%3Ftoken%3Dinstall%26folder%3DTasks%26tab%3Dinbox; Path=/notifications; Max-Age=600; SameSite=Strict; Secure');
		expect(restoreInstallEnrollment(new URLSearchParams()).toString()).toBe('token=install&folder=Tasks&tab=inbox');
	});

	it('preserves explicit notification targets when restoring an empty-storage launch', () => {
		preserveInstallEnrollment('https://worker.test/notifications?token=install&folder=Tasks&tab=inbox');
		const restored = restoreInstallEnrollment(new URLSearchParams('tab=today&reminderId=due&token='));
		expect(restored.get('token')).toBe('install');
		expect(restored.get('tab')).toBe('today');
		expect(restored.get('reminderId')).toBe('due');
		expect(restored.get('folder')).toBe('Tasks');
	});

	it('uses a fresh explicit app link in preference to an older copied cookie', () => {
		preserveInstallEnrollment('https://worker.test/notifications?token=old&folder=Old');
		const fresh = new URLSearchParams('token=new&folder=New');
		expect(restoreInstallEnrollment(fresh)).toBe(fresh);
	});

	it('does not overwrite an outstanding install grant on a visit without a new grant', () => {
		preserveInstallEnrollment('https://worker.test/notifications?token=install&folder=Tasks');
		const cookie = document.cookie;
		preserveInstallEnrollment('https://worker.test/notifications');
		expect(document.cookie).toBe(cookie);
	});

	it('expires the copied grant after successful installation or logout', () => {
		clearInstallEnrollment();
		expect(document.cookie).toBe('crate-reminders-install=; Path=/notifications; Max-Age=0; SameSite=Strict; Secure');
	});

	it('ignores malformed cookies and tolerates blocked cookie access', () => {
		const params = new URLSearchParams('tab=today');
		document.cookie = 'crate-reminders-install=%not-encoded';
		expect(restoreInstallEnrollment(params)).toBe(params);
		Object.defineProperty(document, 'cookie', {
			get: () => { throw new Error('Cookies blocked'); },
			set: () => { throw new Error('Cookies blocked'); },
		});
		expect(() => preserveInstallEnrollment('https://worker.test/notifications?token=install')).not.toThrow();
		expect(restoreInstallEnrollment(params)).toBe(params);
	});
});

it('recognizes a spent icon grant without storing its secret or blocking a fresh grant', async () => {
	const fingerprint = await enrollmentFingerprint('used-on-first-launch');
	expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
	expect(wasEnrollmentRedeemed(fingerprint)).toBe(false);
	rememberRedeemedEnrollment(fingerprint);
	expect(wasEnrollmentRedeemed(await enrollmentFingerprint('used-on-first-launch'))).toBe(true);
	expect(wasEnrollmentRedeemed(await enrollmentFingerprint('fresh-reconnect-link'))).toBe(false);
});

it('retains the installed icon identity and recent renewals with bounded storage', async () => {
	const fingerprints = await Promise.all(Array.from({ length: 40 }, (_, index) => enrollmentFingerprint(`grant-${index}`)));
	for (const fingerprint of fingerprints) rememberRedeemedEnrollment(fingerprint);
	expect(wasEnrollmentRedeemed(fingerprints[0]!)).toBe(true);
	expect(wasEnrollmentRedeemed(fingerprints[1]!)).toBe(false);
	expect(wasEnrollmentRedeemed(fingerprints[38]!)).toBe(true);
	expect(wasEnrollmentRedeemed(fingerprints[39]!)).toBe(true);
	const history: unknown = JSON.parse(localStorage.getItem('crate-reminders-redeemed-enrollment')!);
	expect(history).toHaveLength(32);
	rememberRedeemedEnrollment(fingerprints[0]!);
	expect(JSON.parse(localStorage.getItem('crate-reminders-redeemed-enrollment')!)).toEqual(history);
});

it('migrates the previous single fingerprint without losing the original icon', async () => {
	const original = await enrollmentFingerprint('original-install');
	const renewal = await enrollmentFingerprint('renewal');
	localStorage.setItem('crate-reminders-redeemed-enrollment', original);
	expect(wasEnrollmentRedeemed(original)).toBe(true);
	rememberRedeemedEnrollment(renewal);
	expect(wasEnrollmentRedeemed(original)).toBe(true);
	expect(wasEnrollmentRedeemed(renewal)).toBe(true);
});

it('pins the actual installed grant when browser and Home Screen share storage', async () => {
	rememberRedeemedEnrollment(await enrollmentFingerprint('browser-before-install'));
	const installed = await enrollmentFingerprint('original-home-screen-grant');
	rememberRedeemedEnrollment(installed, true);
	for (let index = 0; index < 40; index++) {
		rememberRedeemedEnrollment(await enrollmentFingerprint(`renewal-${index}`), true);
	}
	clearInstallEnrollment();
	expect(wasEnrollmentRedeemed(installed)).toBe(true);
	expect(localStorage.getItem('crate-reminders-installed-enrollment')).toBe(installed);
});

it.each(['not json', '{}', '[null, false, "not-a-fingerprint"]'])('ignores corrupt history: %s', async raw => {
	const fingerprint = await enrollmentFingerprint('new-install');
	localStorage.setItem('crate-reminders-redeemed-enrollment', raw);
	expect(wasEnrollmentRedeemed(fingerprint)).toBe(false);
	rememberRedeemedEnrollment(fingerprint);
	expect(wasEnrollmentRedeemed(fingerprint)).toBe(true);
});
