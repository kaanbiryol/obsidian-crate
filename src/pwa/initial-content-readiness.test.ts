import { describe, expect, it } from 'vitest';
import { isInitialPwaContentReady } from './initial-content-readiness';

describe('initial PWA content readiness', () => {
	it('waits only for reminder hydration before revealing authenticated content', () => {
		expect(isInitialPwaContentReady({
			authToken: 'token',
			bootstrapped: true,
			loading: true,
		})).toBe(false);
		expect(isInitialPwaContentReady({
			authToken: 'token',
			bootstrapped: true,
			loading: false,
		})).toBe(true);
	});

	it('does not hold the unauthenticated screen behind notification state', () => {
		expect(isInitialPwaContentReady({
			authToken: null,
			bootstrapped: true,
			loading: false,
		})).toBe(true);
	});
});
