import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import type { Priority, Reminder, RecurrenceRule } from '../../types';
import { parseReminderContent } from '../../utils/reminderParser';
import { findStandalonePriorityMarkerIndexes } from '../../utils/priorityMarker';
import { recurrenceToText } from '../../utils/rruleConverter';
import { parseReminderDateValue, serializeReminderDateValue } from '../../utils/reminderDate';

type UpdateOptions = {
	mode?: 'timeout' | 'raf';
	delayMs?: number;
	afterUpdate?: () => void;
};

interface UseReminderDraftOptions {
	reminder?: Reminder;
	projects: string[];
	defaultProject: string;
	initialDueDate?: string;
}

function getDefaultProject(defaultProject: string): string {
	return defaultProject || 'Inbox';
}

export function buildInitialReminderContent(
	reminder: Reminder | undefined,
	defaultProject: string,
	initialDueDate?: string,
): string {
	if (!reminder) {
		return '';
	}

	let reconstructed = reminder.content || '';
	if (reminder.recurrence) {
		reconstructed += ` ${recurrenceToText(reminder.recurrence)}`;
	} else {
		const effectiveDate = reminder.dueDatetime || reminder.dueDate || initialDueDate;
		if (effectiveDate) {
			const isDateOnly = !reminder.dueDatetime && !!reminder.dueDate;
			const fmt = isDateOnly ? 'MMM d, yyyy' : 'MMM d, yyyy HH:mm';
			const parsedDate = parseReminderDateValue(effectiveDate, !isDateOnly);
			if (parsedDate) {
				reconstructed += ` ${format(parsedDate, fmt)}`;
			}
		}
	}

	const resolvedDefaultProject = getDefaultProject(defaultProject);
	if (
		reminder.project &&
		reminder.project !== resolvedDefaultProject &&
		reminder.project !== 'Inbox'
	) {
		reconstructed += ` #${reminder.project}`;
	}

	if (reminder.priority === 1) {
		reconstructed += ' !';
	}

	return reconstructed.trim();
}

export function rebuildReminderContent(
	cleanText: string,
	date: string | null,
	recurrence: RecurrenceRule | undefined,
	project: string,
	priority: number,
	defaultProject: string,
	hasTime?: boolean,
): string {
	let result = cleanText.trim();

	if (recurrence) {
		result += ` ${recurrenceToText(recurrence)}`;
	} else if (date) {
		const fmt = hasTime ? 'MMM d, yyyy HH:mm' : 'MMM d, yyyy';
		const parsedDate = parseReminderDateValue(date, hasTime);
		if (parsedDate) {
			result += ` ${format(parsedDate, fmt)}`;
		}
	}

	const resolvedDefaultProject = getDefaultProject(defaultProject);
	if (project && project !== resolvedDefaultProject && project !== 'Inbox') {
		result += ` #${project}`;
	}

	if (priority === 1) {
		result += ' !';
	}

	return `${result} `;
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

	const [content, setContent] = useState(() => initialContent);
	const [project, setProject] = useState(initialProject);
	const [priority, setPriority] = useState(reminder?.priority || 4);
	const [dueDate, setDueDate] = useState<string | null>(initialDueDateValue);
	const [hasTime, setHasTime] = useState<boolean>(() => {
		if (reminder) return !!reminder.dueDatetime;
		return false;
	});
	const [isUpdatingFromButtons, setIsUpdatingFromButtons] = useState(false);
	const [recurrence, setRecurrence] = useState<RecurrenceRule | undefined>(reminder?.recurrence);

	const recurrenceSetFromText = useRef(false);
	const dueDateSetFromText = useRef(false);
	const dueDateRef = useRef(dueDate);
	const recurrenceRef = useRef(recurrence);
	const hasTimeRef = useRef(hasTime);

	useEffect(() => {
		dueDateRef.current = dueDate;
		recurrenceRef.current = recurrence;
		hasTimeRef.current = hasTime;
	}, [dueDate, recurrence, hasTime]);

	const initialContentHadDate = useMemo(() => {
		const parsed = parseReminderContent(initialContent, projects);
		return !!parsed.dueDate;
	}, [initialContent, projects]);

	const finalizeUpdate = useCallback((options?: UpdateOptions) => {
		const mode = options?.mode ?? 'timeout';
		const delayMs = options?.delayMs ?? 100;
		const complete = () => {
			setIsUpdatingFromButtons(false);
			options?.afterUpdate?.();
		};
		if (mode === 'raf') {
			requestAnimationFrame(() => {
				requestAnimationFrame(complete);
			});
			return;
		}
		setTimeout(complete, delayMs);
	}, []);

	const applyContentUpdate = useCallback((next: {
		dueDate?: string | null;
		recurrence?: RecurrenceRule | null;
		project?: string;
		priority?: Priority;
		hasTime?: boolean;
	}, options?: UpdateOptions) => {
		setIsUpdatingFromButtons(true);
		const parsed = parseReminderContent(content, projects);
		const cleanText = parsed.cleanContent ?? content.trim();

		const nextDueDate = next.dueDate !== undefined ? next.dueDate : dueDateRef.current;
		const nextRecurrence = next.recurrence !== undefined ? (next.recurrence ?? undefined) : recurrenceRef.current;
		const nextProject = next.project !== undefined ? next.project : project;
		const nextPriority = next.priority !== undefined ? next.priority : priority;
		const nextHasTime = next.hasTime !== undefined ? next.hasTime : hasTimeRef.current;

		if (next.dueDate !== undefined) {
			setDueDate(next.dueDate);
		}
		if (next.recurrence !== undefined) {
			setRecurrence(next.recurrence ?? undefined);
		}
		if (next.project !== undefined) {
			setProject(next.project);
		}
		if (next.priority !== undefined) {
			setPriority(next.priority);
		}
		if (next.hasTime !== undefined) {
			setHasTime(next.hasTime);
		}

		setContent(
			rebuildReminderContent(
				cleanText,
				nextDueDate,
				nextRecurrence,
				nextProject,
				nextPriority,
				resolvedDefaultProject,
				nextHasTime,
			),
		);
		finalizeUpdate(options);
	}, [content, finalizeUpdate, priority, project, projects, resolvedDefaultProject]);

	useEffect(() => {
		if (isUpdatingFromButtons) {
			return;
		}

		const parsed = parseReminderContent(content, projects);
		const detectedPriority = parsed.priority;
		const hasPriorityMarker = !!parsed.priorityPart;

		if (hasPriorityMarker && detectedPriority !== priority) {
			setPriority(detectedPriority);
		} else if (!hasPriorityMarker && priority !== 4) {
			const hadImportantMarker = findStandalonePriorityMarkerIndexes(content).length > 0;
			if (!hadImportantMarker) {
				setPriority(4);
			}
		}

		const detectedProject = parsed.project;
		if (detectedProject && detectedProject !== project) {
			setProject(detectedProject);
		} else if (!detectedProject && project !== resolvedDefaultProject) {
			setProject(resolvedDefaultProject);
		}

		const detectedRecurrence = parsed.recurrence;
		if (detectedRecurrence) {
			const currentJson = recurrenceRef.current ? JSON.stringify(recurrenceRef.current) : null;
			const detectedJson = JSON.stringify(detectedRecurrence);
			if (currentJson !== detectedJson) {
				recurrenceSetFromText.current = true;
				setRecurrence(detectedRecurrence);
				if (dueDateRef.current || parsed.dueDate) {
					setDueDate(null);
					setHasTime(false);
					dueDateSetFromText.current = false;
					const cleanText = parsed.cleanContent ?? content.trim();
					setContent(
						rebuildReminderContent(
							cleanText,
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
		} else if (recurrenceRef.current && recurrenceSetFromText.current) {
			setRecurrence(undefined);
			recurrenceSetFromText.current = false;
		}

		const detectedDueDate = parsed.dueDate;
		if (detectedDueDate && !detectedRecurrence) {
			const newHasTime = parsed.hasTime ?? false;
			const newDueDateStr = serializeReminderDateValue(detectedDueDate, newHasTime) ?? null;
			if (dueDateRef.current !== newDueDateStr) {
				dueDateSetFromText.current = true;
				setDueDate(newDueDateStr);
			}
			if (hasTimeRef.current !== newHasTime) {
				setHasTime(newHasTime);
			}
		} else if (
			!detectedDueDate &&
			!detectedRecurrence &&
			dueDateRef.current &&
			(initialContentHadDate || dueDateSetFromText.current)
		) {
			setDueDate(null);
			setHasTime(false);
			dueDateSetFromText.current = false;
		}
	}, [content, initialContentHadDate, isUpdatingFromButtons, priority, project, projects, resolvedDefaultProject]);

	const applyDateSelection = useCallback((nextDate: string | null, nextHasTime?: boolean) => {
		dueDateSetFromText.current = false;
		recurrenceSetFromText.current = false;
		applyContentUpdate({
			dueDate: nextDate,
			recurrence: null,
			hasTime: nextDate ? (nextHasTime ?? hasTimeRef.current) : false,
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

	const togglePriority = useCallback((afterUpdate?: () => void) => {
		const nextPriority = priority === 1 ? 4 : 1;
		applyContentUpdate(
			{ priority: nextPriority },
			{ mode: 'raf', afterUpdate },
		);
	}, [applyContentUpdate, priority]);

	return {
		content,
		setContent,
		project,
		priority,
		dueDate,
		hasTime,
		recurrence,
		isUpdatingFromButtons,
		applyDateSelection,
		applyProjectSelection,
		applyRecurrenceSelection,
		togglePriority,
	};
}
