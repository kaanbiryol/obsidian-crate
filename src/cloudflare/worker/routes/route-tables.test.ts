import { describe, expect, it } from 'vitest';
import { apiRoutePolicy, ENCRYPTION_RESET_PATHS, KEYLESS_ENCRYPTED_READ_PATHS, rateLimitedActions } from './policy';
import { PUBLIC_ASSET_PATHS, requestAdmissionKind } from './admission';
import { isCrateMutation, READ_ONLY_POST_PATHS } from '../../../protocol/server-info';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

// Rate limits and encryption guards are declared on the policy table. Lists kept
// elsewhere must name a route that admission accepts, or they silently never apply.
describe('worker route tables', () => {
	it('rate limits only admitted API routes', () => {
		for (const action of rateLimitedActions.keys()) {
			const [method = '', path = ''] = action.split(' ');
			expect(apiRoutePolicy(path, method), action).toBeDefined();
			expect(requestAdmissionKind(new Request(`https://worker.test${path}`, { method })), action).toBe('api');
		}
	});

	it('treats only admitted, uncoordinated POST routes as reads', () => {
		for (const path of READ_ONLY_POST_PATHS) {
			const policy = apiRoutePolicy(path, 'POST');
			expect(policy, path).toBeDefined();
			expect(policy?.execution?.kind, path).not.toBe('coordinator');
			expect(isCrateMutation(path, 'POST'), path).toBe(false);
		}
	});

	it('derives the encryption guards and rate limits from the policy table', () => {
		expect([...ENCRYPTION_RESET_PATHS].sort()).toEqual(['/encryption', '/encryption/reset', '/health']);
		expect([...KEYLESS_ENCRYPTED_READ_PATHS].sort()).toEqual(['/features', '/reading/encryption', '/reading/session']);
		expect(Object.fromEntries(rateLimitedActions)).toEqual({
			'POST /reading/shortcut-pairing': 5, 'POST /reading/shortcut/v1/exchange': 10,
			'POST /notifications/share/reading': 30, 'POST /reading/handoff': 30,
			'POST /reading/shortcut/v1/prepare': 30, 'POST /reading/capture': 30, 'POST /reading/encrypted-extract': 30,
			'POST /reading/update': 60, 'POST /reading/retry': 10, 'POST /reading/delete': 30,
			'POST /reading/policy': 10, 'POST /features': 10,
			'POST /notifications/reminders-exchange': 10, 'POST /notifications/reminders-enrollment-token': 10,
			'POST /notifications/subscribe': 30, 'DELETE /notifications/subscribe': 30,
			'POST /notifications/test': 3,
		});
	});

	it('keeps public assets outside the API policy', () => {
		for (const path of PUBLIC_ASSET_PATHS) {
			expect(METHODS.some(method => apiRoutePolicy(path, method)), path).toBe(false);
			expect(requestAdmissionKind(new Request(`https://worker.test${path}`)), path).toBe('asset');
		}
	});
});
