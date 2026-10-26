import { describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../types';
import {
	applyReminderDraftContentUpdate,
	buildInitialReminderContent,
	deriveReminderDraftContentMetadata,
	rebuildReminderContent,
	reconcileReminderDraftMetadata,
	type ReminderDraftContentState,
} from './reminderDraft';

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
	return {
		id: 'r1',
		content: 'Task',
		priority: 4,
		completed: false,
		project: 'Inbox',
		...overrides,
	};
}

describe('reminder draft content helpers', () => {
	it('keeps an explicit Inbox selection when the default project is Work', () => {
		const projects = ['Inbox', 'Work'];
		const initial = { content: 'Task', project: 'Work', dueDate: null, recurrence: undefined, priority: 4 as const, hasTime: false };
		const selected = applyReminderDraftContentUpdate(initial, { project: 'Inbox' }, projects, 'Work');
		expect(selected.content.trim()).toBe('Task #Inbox');
		expect(deriveReminderDraftContentMetadata(selected.content, projects, 'Work').project).toBe('Inbox');
		const important = applyReminderDraftContentUpdate(selected, { priority: 1 }, projects, 'Work');
		expect(deriveReminderDraftContentMetadata(important.content, projects, 'Work')).toMatchObject({ project: 'Inbox', priority: 1 });
		expect(buildInitialReminderContent(makeReminder(), 'Work')).toBe('Task #Inbox');
		expect(buildInitialReminderContent(makeReminder(), 'Inbox')).toBe('Task');
	});

	it('rebuilds existing reminder content with date, project, and priority', () => {
		const content = buildInitialReminderContent(
			makeReminder({
				dueDate: '2026-04-03',
				project: 'Work',
				priority: 1,
			}),
			'Inbox',
		);

		expect(content).toContain('Task');
		expect(content).toContain('Apr 3, 2026');
		expect(content).toContain('#Work');
		expect(content).toContain('!');
	});

	it('uses recurrence text instead of date text', () => {
		const content = buildInitialReminderContent(
			makeReminder({
				dueDate: '2026-04-03',
				recurrence: { frequency: 'daily', hour: 9, minute: 0 },
			}),
			'Inbox',
		);

		expect(content).toContain('daily 09:00');
		expect(content).not.toContain('Apr 3, 2026');
	});

	it('derives inline metadata through one shared parser boundary', () => {
		const metadata = deriveReminderDraftContentMetadata(
			'Finish report #Work ! 2026-04-03',
			['Inbox', 'Work'],
			'Inbox',
		);

		expect(metadata).toMatchObject({
			cleanContent: 'Finish report',
			dueDate: '2026-04-03',
			hasDate: true,
			recurrence: undefined,
			project: 'Work',
			hasProject: true,
			priority: 1,
			hasPriorityMarker: true,
			hasTime: false,
		});
	});

	it('treats recurrence as mutually exclusive with a due date', () => {
		const metadata = deriveReminderDraftContentMetadata(
			'Plan daily 09:00',
			['Inbox'],
			'Inbox',
		);

		expect(metadata.dueDate).toBeNull();
		expect(metadata.recurrence).toMatchObject({ frequency: 'daily', hour: 9, minute: 0 });
		expect(metadata.hasTime).toBe(false);
	});

	it('rebuilds content with selected metadata and trailing edit space', () => {
		const content = rebuildReminderContent(
			'Task',
			'2026-04-03T15:30:00.000Z',
			undefined,
			'Work',
			1,
			'Inbox',
			true,
		);

		expect(content).toContain('Task');
		expect(content).toContain('Apr 3, 2026');
		expect(content).toContain('#Work');
		expect(content).toContain('!');
		expect(content.endsWith(' ')).toBe(true);
	});

	it('composes rapid project and priority updates from the latest draft', () => {
		const initial = {
			content: 'Task',
			dueDate: null,
			recurrence: undefined,
			project: 'Inbox',
			priority: 4 as const,
			hasTime: false,
		};
		const withProject = applyReminderDraftContentUpdate(
			initial,
			{ project: 'Work' },
			['Inbox', 'Work'],
			'Inbox',
		);
		const withPriority = applyReminderDraftContentUpdate(
			withProject,
			{ priority: 1 },
			['Inbox', 'Work'],
			'Inbox',
		);

		expect(withPriority.project).toBe('Work');
		expect(withPriority.priority).toBe(1);
		expect(withPriority.content).toContain('#Work');
		expect(withPriority.content).toContain('!');
	});

	it('replaces a selected date with recurrence in one transaction', () => {
		const initial = {
			content: 'Task Apr 3, 2026',
			dueDate: '2026-04-03',
			recurrence: undefined,
			project: 'Inbox',
			priority: 4 as const,
			hasTime: false,
		};
		const recurrence = { frequency: 'daily' as const, hour: 9, minute: 0 };
		const updated = applyReminderDraftContentUpdate(
			initial,
			{ recurrence, dueDate: null },
			['Inbox'],
			'Inbox',
		);

		expect(updated.dueDate).toBeNull();
		expect(updated.recurrence).toEqual(recurrence);
		expect(updated.content).toContain('daily 09:00');
		expect(updated.content).not.toContain('Apr 3, 2026');
	});
});

describe('draft metadata reconciliation', () => {
	const projects = ['Inbox', 'Work'];
	const source = { initialContentHadSchedule: true, dueDateSetFromText: false, recurrenceTimezone: 'preserve' as const };
	const draft = (overrides: Partial<ReminderDraftContentState> = {}): ReminderDraftContentState => ({
		content: 'Task', dueDate: '2026-04-03', hasTime: false, recurrence: undefined, project: 'Inbox', priority: 4, ...overrides,
	});
	const metadata = (content: string) => deriveReminderDraftContentMetadata(content, projects, 'Inbox');

	it('retains implicit initial dates but clears dates whose text was removed', () => {
		const current = draft();
		expect(reconcileReminderDraftMetadata(current, metadata('Task'), { ...source, initialContentHadSchedule: false }).state.dueDate).toBe('2026-04-03');
		for (const provenance of [source, { ...source, initialContentHadSchedule: false, dueDateSetFromText: true }]) {
			expect(reconcileReminderDraftMetadata(current, metadata('Task'), provenance)).toMatchObject({
				state: { dueDate: null, hasTime: false }, dueDateSetFromText: false,
			});
		}
	});

	it('preserves recurrence identity, hidden metadata and the exact occurrence on title edits', () => {
		const recurrence = { frequency: 'weekly' as const, daysOfWeek: [1], hour: 9, minute: 0, timezone: 'America/New_York', count: 8, completedCount: 3 };
		const current = draft({ recurrence, dueDate: '2026-10-26T13:00:37.123Z', hasTime: true });
		const content = buildInitialReminderContent(makeReminder({ content: 'Renamed', recurrence }), 'Inbox');
		for (const recurrenceTimezone of ['preserve', 'local-default'] as const) {
			const next = reconcileReminderDraftMetadata(current, metadata(content), { ...source, recurrenceTimezone });
			expect(next.state.recurrence).toBe(recurrence);
			expect(next.state.dueDate).toBe(current.dueDate);
			expect(next.state.hasTime).toBe(true);
		}
	});

	it('resets occurrences for replaced recurrence and clears a removed schedule', () => {
		const current = draft({ recurrence: { frequency: 'weekly', hour: 9, minute: 0 }, hasTime: true });
		expect(reconcileReminderDraftMetadata(current, metadata('Task daily 10:00'), source).state).toMatchObject({
			recurrence: { frequency: 'daily', hour: 10, minute: 0 }, dueDate: null, hasTime: false,
		});
		expect(reconcileReminderDraftMetadata(current, metadata('Task #Work !'), source).state).toMatchObject({
			recurrence: undefined, dueDate: null, hasTime: false, project: 'Work', priority: 1,
		});
	});

	it('uses the parsed relative date across later reconciliations', () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2026-04-03T12:00:00Z'));
			const parsed = metadata('Task in 5 minutes');
			const first = reconcileReminderDraftMetadata(draft({ dueDate: null }), parsed, source);
			expect(first.state.dueDate).toBe('2026-04-03T12:05:00.000Z');
			vi.advanceTimersByTime(120_000);
			const later = reconcileReminderDraftMetadata(first.state, parsed, { ...source, dueDateSetFromText: first.dueDateSetFromText });
			expect(later.state.dueDate).toBe(first.state.dueDate);
		} finally { vi.useRealTimers(); }
	});
});

it.each(['Inbox', 'Work'])('keeps earlier project mentions when reopening in the default project %s', project => {
	const content = buildInitialReminderContent({ id: 'one', content: 'Compare #Home with', project, priority: 4, completed: false }, project);
	expect(content).toBe(`Compare #Home with #${project}`);
	expect(deriveReminderDraftContentMetadata(content, ['Inbox', 'Home', 'Work'], project)).toMatchObject({
		cleanContent: 'Compare #Home with', project,
	});
});
