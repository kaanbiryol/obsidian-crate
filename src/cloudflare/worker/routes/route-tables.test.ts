import { describe, expect, it } from 'vitest';
import { apiRoutePolicy } from './policy';
import { PUBLIC_ASSET_PATHS, requestAdmissionKind } from './admission';
import { rateLimitedActions } from '../rate-limit';
import { ENCRYPTION_RESET_PATHS, KEYLESS_ENCRYPTED_READ_PATHS } from '../request-guards';
import { isCrateMutation, READ_ONLY_POST_PATHS } from '../../../protocol/server-info';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

// Route metadata lives in several tables. Each entry outside the policy table
// must name a route that admission accepts, or it silently never applies.
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

	it('names only declared routes in the encryption guards', () => {
		for (const path of ENCRYPTION_RESET_PATHS) {
			expect(METHODS.some(method => apiRoutePolicy(path, method)), path).toBe(true);
		}
		for (const path of KEYLESS_ENCRYPTED_READ_PATHS) expect(apiRoutePolicy(path, 'GET'), path).toBeDefined();
	});

	it('keeps public assets outside the API policy', () => {
		for (const path of PUBLIC_ASSET_PATHS) {
			expect(METHODS.some(method => apiRoutePolicy(path, method)), path).toBe(false);
			expect(requestAdmissionKind(new Request(`https://worker.test${path}`)), path).toBe('asset');
		}
	});
});
