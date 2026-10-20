import { describe, expect, it } from 'vitest';
import { createReminderRequestCoordinator } from './reminder-request-coordinator';

describe('PWA reminder request coordinator', () => {
	it('rejects a read that started before an optimistic mutation', () => {
		const coordinator = createReminderRequestCoordinator();
		const staleRead = coordinator.beginRead();
		const endMutation = coordinator.beginMutation();

		expect(coordinator.shouldApplyRead(staleRead)).toBe(false);

		endMutation();
		expect(coordinator.shouldApplyRead(staleRead)).toBe(false);
		expect(coordinator.shouldApplyRead(coordinator.beginRead())).toBe(true);
	});

	it('rejects reads started during a mutation after the mutation settles', () => {
		const coordinator = createReminderRequestCoordinator();
		const endMutation = coordinator.beginMutation();
		const staleRead = coordinator.beginRead();

		endMutation();

		expect(coordinator.shouldApplyRead(staleRead)).toBe(false);
		expect(coordinator.shouldApplyRead(coordinator.beginRead())).toBe(true);
	});

	it('allows only the newest read to replace reminder state', () => {
		const coordinator = createReminderRequestCoordinator();
		const olderRead = coordinator.beginRead();
		const newerRead = coordinator.beginRead();

		expect(coordinator.shouldApplyRead(olderRead)).toBe(false);
		expect(coordinator.shouldApplyRead(newerRead)).toBe(true);
	});

	it('keeps reads blocked until concurrent mutations have all settled', () => {
		const coordinator = createReminderRequestCoordinator();
		const endFirst = coordinator.beginMutation();
		const endSecond = coordinator.beginMutation();

		endFirst();
		expect(coordinator.shouldApplyRead(coordinator.beginRead())).toBe(false);

		endSecond();
		expect(coordinator.shouldApplyRead(coordinator.beginRead())).toBe(true);
	});

	it('invalidates reads when local reminder state is reset', () => {
		const coordinator = createReminderRequestCoordinator();
		const read = coordinator.beginRead();

		coordinator.invalidateReads();

		expect(coordinator.shouldApplyRead(read)).toBe(false);
	});
});
