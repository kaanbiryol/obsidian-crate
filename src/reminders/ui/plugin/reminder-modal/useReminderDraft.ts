import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Reminder, RecurrenceRule } from '../../../types/reminder';
import {
	applyReminderDraftContentUpdate,
	buildInitialReminderContent,
	deriveReminderDraftContentMetadata,
	getDefaultProject,
	reconcileReminderDraftMetadata,
	type ReminderDraftContentMetadata,
	type ReminderDraftContentPatch,
	type ReminderDraftContentState,
} from '../../../core/reminderDraft';

/** Whether text already carries a date or recurrence. Removing it from text that
 * started with one clears the schedule. */
export function draftContentHasSchedule(content: string, projects: string[], defaultProject: string): boolean {
	const metadata = deriveReminderDraftContentMetadata(content, projects, defaultProject);
	return metadata.dueDate !== null || metadata.recurrence !== undefined;
}

/** Applies metadata parsed from the draft text to its fields. A recurrence equal
 * by value keeps its previous object, so the draft state does not change. */
export function reconcileDraftWithText(
	current: ReminderDraftContentState,
	metadata: ReminderDraftContentMetadata,
	schedule: { initialContentHadSchedule: boolean; dueDateSetFromText: boolean },
): { state: ReminderDraftContentState; dueDateSetFromText: boolean } {
	const next = reconcileReminderDraftMetadata(current, metadata, { ...schedule, recurrenceTimezone: 'preserve' });
	if (JSON.stringify(next.state.recurrence) === JSON.stringify(current.recurrence)) next.state.recurrence = current.recurrence;
	return next;
}

interface UseReminderDraftOptions {
	reminder?: Reminder;
	projects: string[];
	defaultProject: string;
	initialDueDate?: string;
}

export function useReminderDraft({
	reminder,
	projects,
	defaultProject,
	initialDueDate,
}: UseReminderDraftOptions) {
	const resolvedDefaultProject = getDefaultProject(defaultProject);
	const initialContent = useMemo(
		() => buildInitialReminderContent(reminder, resolvedDefaultProject, initialDueDate),
		[reminder, resolvedDefaultProject, initialDueDate],
	);
	const initialProject = (reminder?.project && String(reminder.project).trim()) || resolvedDefaultProject;
	const initialDueDateValue = reminder?.dueDatetime || reminder?.dueDate || initialDueDate || null;
	const initialHasTime = reminder ? !!reminder.dueDatetime : false;
	const initialPriority = reminder?.priority || 4;
	const initialRecurrence = reminder?.recurrence;

	const [content, setContent] = useState(() => initialContent);
	const [description, setDescription] = useState(reminder?.description ?? '');
	const [project, setProject] = useState(initialProject);
	const [priority, setPriority] = useState(initialPriority);
	const [dueDate, setDueDate] = useState<string | null>(initialDueDateValue);
	const [hasTime, setHasTime] = useState(initialHasTime);
	const [recurrence, setRecurrence] = useState<RecurrenceRule | undefined>(initialRecurrence);

	const dueDateSetFromText = useRef(false);
	const draftRef = useRef<ReminderDraftContentState>({
		content: initialContent,
		dueDate: initialDueDateValue,
		recurrence: initialRecurrence,
		project: initialProject,
		priority: initialPriority,
		hasTime: initialHasTime,
	});
	const setContentIfChanged = useCallback((nextContent: string) => {
		draftRef.current = { ...draftRef.current, content: nextContent };
		setContent((previous) => (previous === nextContent ? previous : nextContent));
	}, []);

	useEffect(() => {
		draftRef.current = { content, dueDate, recurrence, project, priority, hasTime };
	}, [content, dueDate, hasTime, priority, project, recurrence]);

	const initialContentHadSchedule = useMemo(
		() => draftContentHasSchedule(initialContent, projects, resolvedDefaultProject),
		[initialContent, projects, resolvedDefaultProject],
	);

	const applyContentUpdate = useCallback((patch: ReminderDraftContentPatch) => {
		const next = applyReminderDraftContentUpdate(
			draftRef.current,
			patch,
			projects,
			resolvedDefaultProject,
		);
		draftRef.current = next;
		setDueDate(next.dueDate);
		setRecurrence(next.recurrence);
		setProject(next.project);
		setPriority(next.priority);
		setHasTime(next.hasTime);
		setContentIfChanged(next.content);
		return next.content;
	}, [projects, resolvedDefaultProject, setContentIfChanged]);

	// Resolve relative dates once per text change. Re-parsing after setting the
	// resulting due date would move "in 5 minutes" forward on every render.
	const metadata = useMemo(
		() => deriveReminderDraftContentMetadata(content, projects, resolvedDefaultProject),
		[content, projects, resolvedDefaultProject],
	);

	useEffect(() => {
		const next = reconcileDraftWithText(
			{ content, dueDate, hasTime, recurrence, project, priority }, metadata,
			{ initialContentHadSchedule, dueDateSetFromText: dueDateSetFromText.current },
		);
		dueDateSetFromText.current = next.dueDateSetFromText;
		setPriority(next.state.priority);
		setProject(next.state.project);
		setRecurrence(next.state.recurrence);
		setDueDate(next.state.dueDate);
		setHasTime(next.state.hasTime);
	}, [content, dueDate, hasTime, initialContentHadSchedule, metadata, priority, project, recurrence]);

	const applyDateSelection = useCallback((nextDate: string | null, nextHasTime?: boolean) => {
		dueDateSetFromText.current = false;
		applyContentUpdate({
			dueDate: nextDate,
			recurrence: null,
			hasTime: nextDate ? (nextHasTime ?? draftRef.current.hasTime) : false,
		});
	}, [applyContentUpdate]);

	const applyProjectSelection = useCallback((selected: string) => {
		applyContentUpdate({ project: selected });
	}, [applyContentUpdate]);

	const applyRecurrenceSelection = useCallback((rule: RecurrenceRule | null) => {
		dueDateSetFromText.current = false;
		applyContentUpdate({ recurrence: rule, dueDate: null, hasTime: false });
	}, [applyContentUpdate]);

	const togglePriority = useCallback(() => {
		const nextPriority = draftRef.current.priority === 1 ? 4 : 1;
		return applyContentUpdate({ priority: nextPriority });
	}, [applyContentUpdate]);

	return {
		content,
		setContent: setContentIfChanged,
		description,
		setDescription,
		project,
		priority,
		dueDate,
		hasTime,
		recurrence,
		applyDateSelection,
		applyProjectSelection,
		applyRecurrenceSelection,
		togglePriority,
	};
}

export type ReminderDraft = ReturnType<typeof useReminderDraft>;
