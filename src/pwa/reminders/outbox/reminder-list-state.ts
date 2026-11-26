import type { Reminder as SharedReminder } from '@/reminders/core/model';
import type { ReminderRecord } from '../types';
import { DEFAULT_PROJECT } from '@/reminders/core/constants';
import { compareProjects } from '@/reminders/core/reminder-list';
import { toReminder } from '@/reminders/core/toReminder';

// Unchanged records keep the same card data, so memoized cards skip re-rendering.
const sharedReminders = new WeakMap<ReminderRecord, SharedReminder>();

export function toSharedReminder(reminder: ReminderRecord): SharedReminder {
	let shared = sharedReminders.get(reminder);
	if (!shared) sharedReminders.set(reminder, shared = toReminder(reminder));
	return shared;
}

export function reorderProjectReminders(reminders: ReminderRecord[], project: string, orderedIds: string[]): ReminderRecord[] {
	const order = new Map(orderedIds.map((id, index) => [id, index]));
	const activeProjectReminders = reminders
		.filter((reminder) => reminder.project === project && !reminder.completed)
		.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));

	let activeIndex = 0;
	return reminders.map((reminder) => {
		if (reminder.project !== project || reminder.completed) return reminder;
		const nextReminder = activeProjectReminders[activeIndex];
		activeIndex += 1;
		if (!nextReminder) return reminder;
		// Keep unmoved records so their shared card data stays identical.
		return nextReminder.lineNumber === reminder.lineNumber ? nextReminder : { ...nextReminder, lineNumber: reminder.lineNumber };
	});
}

function mergeProject(projects: string[], project: string): string[] {
	const normalized = project.trim() || DEFAULT_PROJECT;
	return projects.includes(normalized) ? projects : [...projects, normalized].sort(compareProjects);
}

function mergeReminderRecord(reminders: ReminderRecord[], record: ReminderRecord): ReminderRecord[] {
	return reminders.some(item => item.id === record.id)
		? reminders.map(item => item.id === record.id ? record : item)
		: [...reminders, record];
}

export type ReminderListEffect =
	| { kind: 'upsert'; record: ReminderRecord }
	| { kind: 'delete'; recordId: string }
	| { kind: 'reorder'; project: string; orderedIds: string[] };

export interface ReminderList { reminders: ReminderRecord[]; projects: string[] }

/** The one way a confirmed, settled or pending change alters the visible list. */
export function applyReminderListEffect(list: ReminderList, effect: ReminderListEffect): ReminderList {
	if (effect.kind === 'upsert') return { reminders: mergeReminderRecord(list.reminders, effect.record), projects: mergeProject(list.projects, effect.record.project) };
	if (effect.kind === 'delete') return { reminders: list.reminders.filter(item => item.id !== effect.recordId), projects: list.projects };
	return { reminders: reorderProjectReminders(list.reminders, effect.project, effect.orderedIds), projects: list.projects };
}

/**
 * Applies effects in order with the same result as folding `applyReminderListEffect`,
 * but in O(reminders + effects): upserts and deletes edit one copy through an id index,
 * and only a reorder materializes the list it needs.
 */
export function applyReminderListEffects(list: ReminderList, effects: Iterable<ReminderListEffect>): ReminderList {
	let { reminders, projects } = list;
	// Removed slots stay `undefined` until the list is compacted.
	let working: (ReminderRecord | undefined)[] | null = null;
	// Every position of each ID: an upsert replaces all copies and a delete removes them, as
	// `applyReminderListEffect` does.
	let index = new Map<string, number[]>();
	const edit = () => {
		if (working) return working;
		index = new Map();
		reminders.forEach((reminder, position) => {
			const positions = index.get(reminder.id);
			if (positions) positions.push(position); else index.set(reminder.id, [position]);
		});
		return working = reminders.slice();
	};
	const compact = () => {
		if (working) reminders = working.filter((reminder): reminder is ReminderRecord => reminder !== undefined);
		working = null;
		return reminders;
	};
	for (const effect of effects) {
		if (effect.kind === 'reorder') {
			reminders = reorderProjectReminders(compact(), effect.project, effect.orderedIds);
			continue;
		}
		const records = edit();
		if (effect.kind === 'delete') {
			for (const position of index.get(effect.recordId) ?? []) records[position] = undefined;
			index.delete(effect.recordId);
			continue;
		}
		const positions = index.get(effect.record.id);
		if (positions) for (const position of positions) records[position] = effect.record;
		else index.set(effect.record.id, [records.push(effect.record) - 1]);
		projects = mergeProject(projects, effect.record.project);
	}
	return { reminders: compact(), projects };
}
