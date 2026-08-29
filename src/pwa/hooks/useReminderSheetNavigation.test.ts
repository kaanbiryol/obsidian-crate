import { describe, expect, it } from 'vitest';
import {
	getImmediateEditorTransitionPatch,
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
			phase: 'opening-after-transition',
			pendingTransition: null,
		});
		expect(reduceReminderSheetNavigation(finished, { type: 'finish-opening' }).phase).toBe('open');
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

	it('starts an animated return while retaining the editor transition patch', () => {
		const pickerState = {
			activeScreen: 'project' as const,
			phase: 'open' as const,
			pendingTransition: null,
		};
		const transition = {
			screen: 'editor' as const,
			patch: { project: 'Work', activePicker: 'project' as const, deleteConfirm: true },
		};

		const returned = reduceReminderSheetNavigation(pickerState, {
			type: 'request-transition',
			transition,
			isClosing: false,
		});
		expect(returned).toEqual({
			activeScreen: 'project',
			phase: 'closing-for-transition',
			pendingTransition: transition,
		});
		expect(getReminderSheetTransitionPatch(transition)).toEqual({
			project: 'Work',
			activePicker: null,
			deleteConfirm: false,
		});
		expect(getImmediateEditorTransitionPatch('project', transition.patch)).toEqual({
			project: 'Work',
			activePicker: 'project',
			deleteConfirm: false,
		});
	});

	it('does not start an editor transition while the sheet is closing', () => {
		const pickerState = {
			activeScreen: 'date' as const,
			phase: 'open' as const,
			pendingTransition: null,
		};

		expect(reduceReminderSheetNavigation(pickerState, {
			type: 'request-transition',
			transition: { screen: 'editor' },
			isClosing: true,
		})).toBe(pickerState);
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
		expect(reduceReminderSheetNavigation(closed, { type: 'finish-opening' })).toBe(closed);
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
			phase: 'opening-after-transition' as const,
			pendingTransition: null,
		};
		expect(reduceReminderSheetNavigation(changed, { type: 'reset' }))
			.toBe(INITIAL_REMINDER_SHEET_NAVIGATION_STATE);
	});
});
