import { expect, it } from 'vitest';
import { readingUpdateReadiness, reminderUpdateReadiness } from './update-readiness';

const reminders = { bootstrapped: true, enabled: true, connected: true, mutationsReady: true,
	initialContentReady: true, interacting: false, preparingMutation: false, launchPending: false,
	loading: false, refreshing: false, isOffline: false, unsettled: false };
const reading = { ready: true, connecting: false, enabled: true, connected: true, hasCache: true,
	hasError: false, adding: false, saving: false, preparingChange: false, syncing: false, isOffline: false };

it('allows paused reminder updates without a network refresh but still protects local work', () => {
	const paused = { ...reminders, enabled: false, initialContentReady: false, loading: true, isOffline: true };
	expect(reminderUpdateReadiness(paused)).toEqual({ updateReady: true, updateContentReady: true });
	for (const blocked of [{ unsettled: true }, { preparingMutation: true }, { interacting: true }, { mutationsReady: false }]) {
		expect(reminderUpdateReadiness({ ...paused, ...blocked }).updateReady).toBe(false);
	}
});

it('keeps reminder launch hydration and transient actions protected, including while disconnected', () => {
	for (const blocked of [{ initialContentReady: false }, { launchPending: true }, { refreshing: true }]) {
		expect(reminderUpdateReadiness({ ...reminders, ...blocked }).updateReady).toBe(false);
	}
	const disconnected = { ...reminders, connected: false, mutationsReady: false };
	expect(reminderUpdateReadiness(disconnected).updateReady).toBe(true);
	expect(reminderUpdateReadiness({ ...disconnected, preparingMutation: true }).updateReady).toBe(false);
	expect(reminderUpdateReadiness({ ...disconnected, interacting: true }).updateReady).toBe(false);
});

it('restores Reading content after an error or disconnection, but not during hydration', () => {
	expect(readingUpdateReadiness({ ...reading, hasCache: false }).updateContentReady).toBe(false);
	for (const restored of [{ hasError: true }, { enabled: false }, { connected: false }]) {
		expect(readingUpdateReadiness({ ...reading, hasCache: false, ...restored }).updateContentReady).toBe(true);
	}
	expect(readingUpdateReadiness({ ...reading, connecting: true })).toEqual({ updateReady: false, updateContentReady: false });
});

it('protects Reading forms, commands, and sync work even when the feature is paused', () => {
	for (const blocked of [{ adding: true }, { saving: true }, { preparingChange: true }, { syncing: true }, { isOffline: true }]) {
		expect(readingUpdateReadiness({ ...reading, enabled: false, ...blocked }).updateReady).toBe(false);
	}
});
