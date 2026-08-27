import { describe, expect, it } from 'vitest';
import {
	getReminderSheetTransitionPatch,
	INITIAL_REMINDER_SHEET_NAVIGATION_STATE,
	reduceReminderSheetNavigation,
} from './useReminderSheetNavigation';

describe('reminder sheet navigation', () => {
	it('closes the editor before activating a picker', () => {
		const requested = reduceReminderSheetNavigation(
			INITIAL_REMINDER_SHEET_NAVIGATION_STATE,
			{
				type: 'request-transition',
				transition: { screen: 'date' },
				isClosing: false,
			},
		);

		expect(requested).toEqual({
			activeScreen: 'editor',
			phase: 'closing-for-transition',
			pendingTransition: { screen: 'date' },
		});

		const finished = reduceReminderSheetNavigation(requested, { type: 'finish-transition' });
		expect(finished).toEqual({
			activeScreen: 'date',
			phase: 'awaiting-reopen',
			pendingTransition: null,
		});
		expect(reduceReminderSheetNavigation(finished, { type: 'reopen' }).phase).toBe('open');
	});

	it('ignores rapid transition requests while a transition is pending', () => {
		const requested = reduceReminderSheetNavigation(
			INITIAL_REMINDER_SHEET_NAVIGATION_STATE,
			{
				type: 'request-transition',
				transition: { screen: 'date' },
				isClosing: false,
			},
		);
		const repeated = reduceReminderSheetNavigation(requested, {
			type: 'request-transition',
			transition: { screen: 'project' },
			isClosing: false,
		});

		expect(repeated).toBe(requested);
		expect(repeated.pendingTransition).toEqual({ screen: 'date' });
	});

	it('closes the picker before returning to the editor with the selected draft patch', () => {
		const pickerState = {
			activeScreen: 'project' as const,
			phase: 'open' as const,
			pendingTransition: null,
		};
		const transition = {
			screen: 'editor' as const,
			patch: { project: 'Work', activePicker: 'project' as const, deleteConfirm: true },
		};

		const requested = reduceReminderSheetNavigation(pickerState, {
			type: 'request-transition',
			transition,
			isClosing: false,
		});
		expect(requested).toEqual({
			activeScreen: 'project',
			phase: 'closing-for-transition',
			pendingTransition: transition,
		});

		expect(reduceReminderSheetNavigation(requested, { type: 'finish-transition' })).toEqual({
			activeScreen: 'editor',
			phase: 'awaiting-reopen',
			pendingTransition: null,
		});
		expect(getReminderSheetTransitionPatch(transition)).toEqual({
			project: 'Work',
			activePicker: null,
			deleteConfirm: false,
		});
	});

	it('lets an external close cancel a pending picker transition', () => {
		const requested = reduceReminderSheetNavigation(
			INITIAL_REMINDER_SHEET_NAVIGATION_STATE,
			{
				type: 'request-transition',
				transition: { screen: 'recurrence' },
				isClosing: false,
			},
		);
		const closed = reduceReminderSheetNavigation(requested, { type: 'finish-external-close' });

		expect(closed).toEqual({
			activeScreen: 'editor',
			phase: 'closed',
			pendingTransition: null,
		});
		expect(reduceReminderSheetNavigation(closed, { type: 'reopen' })).toBe(closed);
	});

	it('blocks new transitions while externally closing and resets for a new reminder', () => {
		const blocked = reduceReminderSheetNavigation(
			INITIAL_REMINDER_SHEET_NAVIGATION_STATE,
			{
				type: 'request-transition',
				transition: { screen: 'project' },
				isClosing: true,
			},
		);
		expect(blocked).toBe(INITIAL_REMINDER_SHEET_NAVIGATION_STATE);

		const changed = {
			activeScreen: 'project' as const,
			phase: 'awaiting-reopen' as const,
			pendingTransition: null,
		};
		expect(reduceReminderSheetNavigation(changed, { type: 'reset' }))
			.toBe(INITIAL_REMINDER_SHEET_NAVIGATION_STATE);
	});
});
