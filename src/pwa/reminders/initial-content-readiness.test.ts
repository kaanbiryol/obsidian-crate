import { describe, expect, it } from 'vitest';
import { isInitialPwaContentReady } from './initial-content-readiness';

describe('initial PWA content readiness', () => {
	it('waits for reminder hydration before revealing authenticated content', () => {
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

 it('reveals reminders and the resolved notification prompt together', () => {
  const ready = { authToken: 'token', bootstrapped: true, loading: false };
  expect(isInitialPwaContentReady({ ...ready, notificationPromptReady: false })).toBe(false);
  expect(isInitialPwaContentReady({ ...ready, notificationPromptReady: true })).toBe(true);
  expect(isInitialPwaContentReady({ ...ready, loading: true, notificationPromptReady: true })).toBe(false);
  expect(isInitialPwaContentReady({ ...ready, authToken: null, notificationPromptReady: false })).toBe(true);
 });

 it('waits for pending local reminders before showing an empty cached Today view', () => {
  const ready = { authToken: 'token', bootstrapped: true, loading: false };
  expect(isInitialPwaContentReady({ ...ready, pendingChangesReady: false })).toBe(false);
  expect(isInitialPwaContentReady({ ...ready, pendingChangesReady: true })).toBe(true);
  expect(isInitialPwaContentReady({ ...ready, loading: true, pendingChangesReady: true })).toBe(false);
  expect(isInitialPwaContentReady({ ...ready, authToken: null, pendingChangesReady: false })).toBe(true);
 });
