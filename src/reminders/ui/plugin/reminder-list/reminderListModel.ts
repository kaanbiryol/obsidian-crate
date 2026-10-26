import {
	getUpcomingReminders,
	sortReminders,
	sortRemindersByFileOrder,
} from "@/reminders/core/reminderSort";
import { isReminderOverdue } from "@/reminders/core/dates/reminderDate";
import type { ReminderRepository } from "@/reminders/data/reminder-repository";
import type { Reminder } from "@/reminders/types/reminder";
import { DEFAULT_PROJECT } from "../../../core/constants";
import { reminderProject } from "@/reminders/core/reminderProjectPath";

export interface RemindersListLoadOptions {
	repository: ReminderRepository;
	showToday?: boolean;
	showUpcoming?: boolean;
	showCompleted: boolean;
	effectiveDays: number;
}

export interface RemindersListPresentationOptions {
	rawReminders: Reminder[];
	projectFilter?: string;
	/** Existing project names; a block's filter matches them case-insensitively. */
	projects?: readonly string[];
	showToday?: boolean;
	showUpcoming?: boolean;
	effectiveDays: number;
	now?: Date;
}

export interface RemindersListPresentation {
	reminders: Reminder[];
	activeReminders: Reminder[];
	activeCount: number;
	completedCount: number;
	overdueCount: number;
	supportsReorder: boolean;
	effectiveProject: string;
	emptyMessage: string;
}

export function loadRemindersListData(options: RemindersListLoadOptions): Reminder[] {
	const {
		repository,
		showToday = false,
		showUpcoming = false,
		showCompleted,
		effectiveDays,
	} = options;

	if (showToday) {
		return repository.getTodayReminders(showCompleted);
	}

	if (showUpcoming) {
		const allReminders = showCompleted ? repository.getAll() : repository.getActive();
		return getUpcomingReminders(allReminders, effectiveDays, new Date(), showCompleted);
	}

	return showCompleted ? repository.getAll() : repository.getActive();
}

export function buildRemindersListPresentation(
	options: RemindersListPresentationOptions,
): RemindersListPresentation {
	const {
		rawReminders,
		projectFilter,
		projects = [],
		showToday = false,
		showUpcoming = false,
		effectiveDays,
		now = new Date(),
	} = options;

	const supportsReorder = Boolean(projectFilter && !showToday && !showUpcoming);
	const normalizedProject = projectFilter?.toLowerCase().trim();
	// Writes use the existing note's name, so `work` adds to and reorders `Work`.
	const effectiveProject = (normalizedProject && projects.find(project => project.toLowerCase() === normalizedProject))
		|| projectFilter?.trim() || DEFAULT_PROJECT;
	const filteredReminders = normalizedProject
		? rawReminders.filter((reminder) => reminderProject(reminder).toLowerCase() === normalizedProject)
		: [...rawReminders];
	const reminders = supportsReorder
		? sortRemindersByFileOrder(filteredReminders)
		: sortReminders(filteredReminders);
	const activeReminders = reminders.filter((reminder) => !reminder.completed);
	const completedCount = reminders.length - activeReminders.length;
	const overdueCount = reminders.filter((reminder) => isReminderOverdue(reminder, now)).length;

	return {
		reminders,
		activeReminders,
		activeCount: activeReminders.length,
		completedCount,
		overdueCount,
		supportsReorder,
		effectiveProject,
		emptyMessage: buildEmptyMessage({ showToday, showUpcoming, effectiveDays, projectFilter }),
	};
}

function buildEmptyMessage(options: {
	showToday: boolean;
	showUpcoming: boolean;
	effectiveDays: number;
	projectFilter?: string;
}): string {
	if (options.showToday) {
		return "No reminders due today";
	}
	if (options.showUpcoming) {
		return `No reminders in the next ${options.effectiveDays} days`;
	}
	if (options.projectFilter) {
		return `No reminders in project "${options.projectFilter}"`;
	}
	return "No reminders";
}
