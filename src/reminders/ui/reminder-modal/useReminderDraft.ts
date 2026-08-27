import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Reminder, RecurrenceRule } from '../../types';
import {
	applyReminderDraftContentUpdate,
	buildInitialReminderContent,
	deriveReminderDraftContentMetadata,
	getDefaultProject,
	rebuildReminderContent,
	type ReminderDraftContentPatch,
	type ReminderDraftContentState,
} from '../../core/reminderDraft';

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
	const initialDueDateValue = reminder?.recurrence
		? null
		: (reminder?.dueDatetime || reminder?.dueDate || initialDueDate || null);
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

	const recurrenceSetFromText = useRef(false);
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

	const initialContentHadDate = useMemo(() => {
		const metadata = deriveReminderDraftContentMetadata(
			initialContent,
			projects,
			resolvedDefaultProject,
		);
		return metadata.dueDate !== null;
	}, [initialContent, projects, resolvedDefaultProject]);

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

	useEffect(() => {
		const metadata = deriveReminderDraftContentMetadata(
			content,
			projects,
			resolvedDefaultProject,
		);

		if (metadata.priority !== priority) {
			setPriority(metadata.priority);
		}

		if (metadata.project !== project) {
			setProject(metadata.project);
		}

		const detectedRecurrence = metadata.recurrence;
		if (detectedRecurrence) {
			const currentJson = recurrence ? JSON.stringify(recurrence) : null;
			const detectedJson = JSON.stringify(detectedRecurrence);
			if (currentJson !== detectedJson) {
				recurrenceSetFromText.current = true;
				setRecurrence(detectedRecurrence);
				if (dueDate || metadata.hasDate) {
					setDueDate(null);
					setHasTime(false);
					dueDateSetFromText.current = false;
					setContentIfChanged(
						rebuildReminderContent(
							metadata.cleanContent,
							null,
							detectedRecurrence,
							project,
							priority,
							resolvedDefaultProject,
							false,
						),
					);
				}
			}
		} else if (recurrence && recurrenceSetFromText.current) {
			setRecurrence(undefined);
			recurrenceSetFromText.current = false;
		}

		const detectedDueDate = metadata.dueDate;
		if (detectedDueDate && !detectedRecurrence) {
			if (dueDate !== detectedDueDate) {
				dueDateSetFromText.current = true;
				setDueDate(detectedDueDate);
			}
			if (hasTime !== metadata.hasTime) {
				setHasTime(metadata.hasTime);
			}
		} else if (
			!detectedDueDate &&
			!detectedRecurrence &&
			dueDate &&
			(initialContentHadDate || dueDateSetFromText.current)
		) {
			setDueDate(null);
			setHasTime(false);
			dueDateSetFromText.current = false;
		}
	}, [content, dueDate, hasTime, initialContentHadDate, priority, project, projects, recurrence, resolvedDefaultProject, setContentIfChanged]);

	const applyDateSelection = useCallback((nextDate: string | null, nextHasTime?: boolean) => {
		dueDateSetFromText.current = false;
		recurrenceSetFromText.current = false;
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
		recurrenceSetFromText.current = false;
		if (!rule) {
			applyContentUpdate({ recurrence: null });
			return;
		}
		dueDateSetFromText.current = false;
		applyContentUpdate({ recurrence: rule, dueDate: null });
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
