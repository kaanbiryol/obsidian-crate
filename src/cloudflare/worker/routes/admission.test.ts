import { expect, it } from 'vitest';
import type { AuthPrincipal } from '../authenticate';
import { affectsNotifications } from '../notification-mutations';
import { canPrepareReadingHandoff } from '../reading/common';
import { isAuthenticatedRouteAllowed } from '../router';
import { READING_SHORTCUT_CONTRACT as shortcut } from '@/reading/shortcut';
import { requestAdmissionKind } from './admission';

const scopes: AuthPrincipal['scope'][] = ['vault', 'reminders', 'reading', 'reading_capture'];

it.each([
	['GET', '/sync/manifest', ['vault'], false],
	['POST', '/sync/checkpoints', ['vault'], true],
	['POST', '/sync/import/complete', ['vault'], true],
	['PUT', '/sync/upload', ['vault'], false],
	['PUT', '/settings', ['vault'], true],
	['GET', '/encryption', ['vault', 'reminders'], false],
	['GET', '/encryption/pairing', ['vault', 'reminders', 'reading'], false],
	['POST', '/encryption/pairing', ['vault', 'reminders', 'reading'], false],
	['GET', '/encryption/reset', ['vault'], true],
	['POST', '/encryption/reset', ['vault'], true],
	['GET', '/encryption/conversion/file', ['vault'], true],
	['PUT', '/encryption/conversion/reading-capture', ['vault'], true],
	['POST', '/encryption/conversion/finish', ['vault'], true],
	['GET', '/reminders/encrypted-receipt', ['vault', 'reminders'], false],
	['POST', '/reminders/encrypted-commit', ['vault', 'reminders'], true],
	['GET', '/reminders/list', ['vault', 'reminders'], false],
	['POST', '/reminders/update', ['vault', 'reminders'], true],
	['DELETE', '/reminders/delete', ['vault', 'reminders'], true],
	['GET', '/reminders/notification-policy', ['vault'], false],
	['PUT', '/reminders/notification-policy', ['vault'], true],
	['POST', '/notifications/subscribe', ['vault', 'reminders'], true],
	['DELETE', '/notifications/subscribe', ['vault', 'reminders'], true],
	['POST', '/notifications/reminders-enrollment-token', ['vault'], true],
	['GET', '/features', ['vault', 'reminders', 'reading'], false],
	['POST', '/features', ['vault'], false],
	['DELETE', '/auth/tokens', ['vault'], true],
	['DELETE', '/auth/session', ['vault', 'reminders', 'reading'], true],
	['GET', '/reading/list', ['vault', 'reminders', 'reading'], false],
	['GET', '/reading/encrypted-file', ['vault', 'reminders', 'reading'], false],
	['POST', '/reading/capture', scopes, false],
	['POST', '/reading/prepare', scopes, false],
	['POST', '/reading/shortcut-pairing', ['vault', 'reminders', 'reading'], false],
	['POST', shortcut.preparePath, ['reading_capture'], false],
] as const)('%s %s enforces admission, scopes and notification coordination', async (method, path, allowed, coordinates) => {
	const request = new Request(`https://test${path}`, { method });
	expect(requestAdmissionKind(request)).toBe('api');
	for (const scope of scopes) {
		expect(isAuthenticatedRouteAllowed({ tokenId: 'device', scope }, path, method), scope)
			.toBe(allowed.some(candidate => candidate === scope));
	}
	expect(await affectsNotifications(request)).toBe(coordinates);
});

it('uses the preparation scope policy when validating a handoff issuer', () => {
	for (const scope of scopes) {
		expect(canPrepareReadingHandoff(scope)).toBe(isAuthenticatedRouteAllowed({ tokenId: 'device', scope }, '/reading/prepare', 'POST'));
	}
	expect(canPrepareReadingHandoff('unknown')).toBe(false);
});

it.each(['/', '/.well-known/crate', '/notifications', '/notifications/sw.js', '/notifications/assets/chunk.js'])('admits public asset %s without admitting writes', path => {
	expect(requestAdmissionKind(new Request(`https://test${path}`))).toBe('asset');
	expect(requestAdmissionKind(new Request(`https://test${path}`, { method: 'POST' }))).toBe('unknown');
});

it.each([0, 1, 2, 999])('admits Shortcut v%s for transport compatibility responses', version => {
	for (const action of ['prepare', 'exchange']) {
		const url = `https://test/reading/shortcut/v${version}/${action}`;
		expect(requestAdmissionKind(new Request(url, { method: 'POST' }))).toBe('api');
		expect(requestAdmissionKind(new Request(url))).toBe('unknown');
	}
});

it.each([
	['DELETE', '/sync/manifest'], ['POST', '/sync/upload'], ['GET', '/reminders/update'],
	['PATCH', '/reading/capture'], ['POST', '/encryption/conversion/file'],
	['POST', '/reading/shortcut/v01/prepare'], ['POST', '/reading/shortcut/v1000/prepare'],
	['GET', '/unknown'], ['GET', '/notifications/unknown'], ['GET', '/__proto__'],
])('rejects unsupported %s %s before authentication or coordination', async (method, path) => {
	const request = new Request(`https://test${path}`, { method });
	expect(requestAdmissionKind(request)).toBe('unknown');
	expect(await affectsNotifications(request)).toBe(false);
});
