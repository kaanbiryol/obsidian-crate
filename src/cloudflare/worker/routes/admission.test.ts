import { expect, it } from 'vitest';
import type { AuthPrincipal } from '../auth/authenticate';
import { apiRoutePolicy } from './policy';
import { canPrepareReadingHandoff } from '../reading/common';
import { isAuthenticatedRouteAllowed } from '../router';
import { READING_SHORTCUT_CONTRACT as shortcut } from '@/reading/shortcut';
import { requestAdmissionKind } from './admission';

const scopes: AuthPrincipal['scope'][] = ['vault', 'reminders', 'reading', 'reading_capture'];

it.each([
	['GET', '/sync/manifest', ['vault'], undefined],
	['POST', '/sync/checkpoints', ['vault'], { kind: 'coordinator', wake: true }],
	['POST', '/sync/import/complete', ['vault'], { kind: 'coordinator', wake: true }],
	['PUT', '/sync/upload', ['vault'], { kind: 'transfer', path: '/sync-upload' }],
	['PUT', '/settings', ['vault'], { kind: 'coordinator', wake: true }],
	['GET', '/encryption', ['vault', 'reminders'], undefined],
	['GET', '/encryption/pairing', ['vault', 'reminders', 'reading'], undefined],
	['POST', '/encryption/pairing', ['vault', 'reminders', 'reading'], undefined],
	['GET', '/encryption/reset', ['vault'], { kind: 'coordinator', wake: true }],
	['POST', '/encryption/reset', ['vault'], { kind: 'coordinator', wake: true }],
	['GET', '/encryption/conversion/file', ['vault'], { kind: 'coordinator', wake: true }],
	['PUT', '/encryption/conversion/reading-capture', ['vault'], { kind: 'coordinator', wake: true }],
	['POST', '/encryption/conversion/finish', ['vault'], { kind: 'coordinator', wake: true }],
	['GET', '/reminders/encrypted-receipt', ['vault', 'reminders'], undefined],
	['POST', '/reminders/encrypted-commit', ['vault', 'reminders'], { kind: 'coordinator', wake: true }],
	['GET', '/reminders/list', ['vault', 'reminders'], undefined],
	['POST', '/reminders/update', ['vault', 'reminders'], { kind: 'coordinator', wake: true }],
	['DELETE', '/reminders/delete', ['vault', 'reminders'], { kind: 'coordinator', wake: true }],
	['GET', '/reminders/notification-policy', ['vault'], undefined],
	['PUT', '/reminders/notification-policy', ['vault'], { kind: 'coordinator', wake: true }],
	['POST', '/notifications/subscribe', ['vault', 'reminders'], { kind: 'coordinator', wake: true }],
	['DELETE', '/notifications/subscribe', ['vault', 'reminders'], { kind: 'coordinator', wake: true }],
	['POST', '/notifications/reminders-enrollment-token', ['vault'], { kind: 'coordinator', wake: true }],
	['GET', '/features', ['vault', 'reminders', 'reading'], undefined],
	['POST', '/features', ['vault'], { kind: 'coordinator', wake: true }],
	['DELETE', '/auth/tokens', ['vault'], { kind: 'coordinator', wake: true }],
	['DELETE', '/auth/session', ['vault', 'reminders', 'reading'], { kind: 'coordinator', wake: true }],
	['GET', '/reading/list', ['vault', 'reminders', 'reading'], { kind: 'coordinator', wake: true }],
	['GET', '/reading/encrypted-file', ['vault', 'reminders', 'reading'], { kind: 'coordinator', wake: true }],
	['POST', '/reading/capture', scopes, { kind: 'coordinator', wake: true }],
	['POST', '/reading/shortcut-pairing', ['vault', 'reminders', 'reading'], { kind: 'coordinator', wake: true }],
	['POST', shortcut.preparePath, ['reading_capture'], { kind: 'coordinator', wake: true }],
] as const)('%s %s enforces admission, scopes and execution', (method, path, allowed, execution) => {
	const request = new Request(`https://test${path}`, { method });
	expect(requestAdmissionKind(request)).toBe('api');
	for (const scope of scopes) {
		expect(isAuthenticatedRouteAllowed({ tokenId: 'device', scope }, path, method), scope)
			.toBe(allowed.some(candidate => candidate === scope));
	}
	expect(apiRoutePolicy(path, method)?.execution).toEqual(execution);
});

it('uses the preparation scope policy when validating a handoff issuer', () => {
	for (const scope of scopes) {
		expect(canPrepareReadingHandoff(scope)).toBe(isAuthenticatedRouteAllowed({ tokenId: 'device', scope }, shortcut.preparePath, 'POST'));
	}
	expect(canPrepareReadingHandoff('unknown')).toBe(false);
});

it.each(['/', '/.well-known/crate', '/notifications', '/notifications/sw.js', '/notifications/assets/chunk.js'])('admits public asset %s without admitting writes', path => {
	expect(requestAdmissionKind(new Request(`https://test${path}`))).toBe('asset');
	expect(requestAdmissionKind(new Request(`https://test${path}`, { method: 'POST' }))).toBe('unknown');
});

it.each([[shortcut.preparePath, { kind: 'coordinator', wake: true }], [shortcut.exchangePath, { kind: 'reading-grant' }]] as const)('admits the current Shortcut route %s', (path, execution) => {
	const url = `https://test${path}`;
	expect(requestAdmissionKind(new Request(url, { method: 'POST' }))).toBe('api');
	expect(requestAdmissionKind(new Request(url))).toBe('unknown');
	expect(apiRoutePolicy(path, 'POST')?.execution).toEqual(execution);
});

it.each([
	['DELETE', '/sync/manifest'], ['POST', '/sync/upload'], ['GET', '/reminders/update'],
	['PATCH', '/reading/capture'], ['POST', '/encryption/conversion/file'],
	['POST', '/reading/shortcut/v0/prepare'], ['POST', '/reading/shortcut/v2/exchange'],
	['POST', '/reading/shortcut/v01/prepare'], ['POST', '/reading/shortcut/v1000/prepare'],
	['GET', '/unknown'], ['GET', '/notifications/unknown'], ['GET', '/__proto__'],
])('rejects unsupported %s %s before authentication or coordination', (method, path) => {
	const request = new Request(`https://test${path}`, { method });
	expect(requestAdmissionKind(request)).toBe('unknown');
	expect(apiRoutePolicy(path, method)).toBeUndefined();
});

it.each([
	['GET', '/sync/check', true], ['GET', '/sync/manifest', true], ['GET', '/reminders/list', true],
	['GET', '/sync/changes', false], ['GET', '/reading/list', false], ['POST', '/sync/check', false],
] as const)('%s %s initializes projection only when required', (method, path, initialize) => {
	expect(apiRoutePolicy(path, method)?.initializeProjection ?? false).toBe(initialize);
});

it.each(['/reading/exchange', '/reading/handoff'])('redeems %s under coordinator authority before ordinary authentication', path => {
	expect(apiRoutePolicy(path, 'POST')?.execution).toEqual({ kind: 'reading-grant' });
});

it('queues batch uploads through the transfer endpoint', () => {
	expect(apiRoutePolicy('/sync/batch-upload', 'POST')?.execution).toEqual({ kind: 'transfer', path: '/sync-batch-upload' });
});
