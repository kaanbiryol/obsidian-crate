import { describe, expect, it } from 'vitest';
import { apiRoutePolicy } from './policy';
import { requestAdmissionKind } from './admission';
import { rateLimitedActions } from '../rate-limit';
import { isCrateMutation, READ_ONLY_POST_PATHS } from '../../../protocol/server-info';

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
});
