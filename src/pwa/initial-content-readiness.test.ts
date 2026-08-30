import { describe, expect, it } from 'vitest';
import { isInitialPwaContentReady } from './initial-content-readiness';

describe('initial PWA content readiness', () => {
	it('waits for both reminders and notification state before revealing authenticated content', () => {
		expect(isInitialPwaContentReady({
			authToken: 'token',
			bootstrapped: true,
			loading: true,
			pushStateReady: true,
		})).toBe(false);
		expect(isInitialPwaContentReady({
			authToken: 'token',
			bootstrapped: true,
			loading: false,
			pushStateReady: false,
		})).toBe(false);
		expect(isInitialPwaContentReady({
			authToken: 'token',
			bootstrapped: true,
			loading: false,
			pushStateReady: true,
		})).toBe(true);
	});

	it('does not hold the unauthenticated screen behind notification state', () => {
		expect(isInitialPwaContentReady({
			authToken: null,
			bootstrapped: true,
			loading: false,
			pushStateReady: false,
		})).toBe(true);
	});
});
