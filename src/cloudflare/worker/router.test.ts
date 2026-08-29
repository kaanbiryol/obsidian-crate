import { describe, expect, it } from 'vitest';
import { isAuthenticatedRouteAllowed } from './router';

describe('authenticated route scopes', () => {
	it('keeps vault tokens fully authorized', () => {
		expect(isAuthenticatedRouteAllowed(
			{ tokenId: 'vault-token', scope: 'vault' },
			'/sync/manifest',
			'GET',
		)).toBe(true);
	});

	it('allows reminder PWA operations and self-revocation', () => {
		const principal = { tokenId: 'pwa-token', scope: 'reminders' } as const;
		expect(isAuthenticatedRouteAllowed(principal, '/reminders/list', 'GET')).toBe(true);
		expect(isAuthenticatedRouteAllowed(principal, '/reminders/update', 'POST')).toBe(true);
		expect(isAuthenticatedRouteAllowed(principal, '/notifications/subscribe', 'POST')).toBe(true);
		expect(isAuthenticatedRouteAllowed(principal, '/auth/session', 'DELETE')).toBe(true);
	});

	it('blocks reminder PWA tokens from vault and device-management APIs', () => {
		const principal = { tokenId: 'pwa-token', scope: 'reminders' } as const;
		expect(isAuthenticatedRouteAllowed(principal, '/sync/manifest', 'GET')).toBe(false);
		expect(isAuthenticatedRouteAllowed(principal, '/sync/download', 'GET')).toBe(false);
		expect(isAuthenticatedRouteAllowed(principal, '/settings', 'GET')).toBe(false);
		expect(isAuthenticatedRouteAllowed(principal, '/auth/tokens', 'GET')).toBe(false);
		expect(isAuthenticatedRouteAllowed(principal, '/notifications/test', 'POST')).toBe(false);
	});
});
