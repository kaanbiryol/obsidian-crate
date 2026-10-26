import { ToggleButton } from '../../../ui/shared/ToggleButton';
import React from 'react';
import { Button } from '../../../ui/shared/Button';
import { ThemeIcon } from '../../../ui/shared/ThemeIcon';
import type { RecurrenceRule } from '../../types';
import { formatRecurrence } from '../../core/recurrence/recurrenceText';
import { formatDueDate } from '../format/dateFormatting';
import { REMINDER_PICKER_COPY } from './pickerCopy';
import { useReminderClock } from '../shared/useReminderClock';
import { AnimatedActionLabel } from './AnimatedActionLabel';

interface ReminderActionChipsProps {
	dueDate: string | null;
	hasTime?: boolean;
	project: string;
	defaultProject: string;
	priority: number;
	recurrence?: RecurrenceRule;
	disabled?: boolean;
	inert?: boolean;
	preventFocusOnPress?: boolean;
	dueDateLabel?: string;
	animateLabels?: boolean;
	onOpenDatePicker: () => void;
	onOpenProjectPicker: () => void;
	onOpenRecurrencePicker: () => void;
	onTogglePriority: () => void;
}

export function ReminderActionChips({
	dueDate,
	project,
	defaultProject,
	priority,
	recurrence,
	disabled,
	inert = false,
	preventFocusOnPress,
	dueDateLabel,
	animateLabels = true,
	onOpenDatePicker,
	onOpenProjectPicker,
	onOpenRecurrencePicker,
	onTogglePriority,
}: ReminderActionChipsProps) {
	const clock = useReminderClock();
	const selectedProject = project || defaultProject || REMINDER_PICKER_COPY.editor.defaultProject;
	// A specific date and a repeat are separate choices. A repeat's occurrence
	// is not a chosen date, so the date chip stays unset.
	const scheduledDate = recurrence ? null : dueDate;
	const dueDateDisplay = recurrence ? undefined : dueDateLabel ?? formatDueDate(scheduledDate ?? undefined, undefined, clock.now);
	const renderLabel = (label: string) => animateLabels
		? <AnimatedActionLabel>{label}</AnimatedActionLabel>
		: <span className="reminder-action-label">{label}</span>;

	return (
		<div className="reminder-action-chips" inert={inert}>
			<Button
				disabled={disabled}
				preventFocusOnPress={preventFocusOnPress}
				onClick={onOpenDatePicker}
				data-action="toggle-picker" data-picker="date"
				aria-haspopup="dialog"
				className={`reminder-action-chip crate-semantic-token tone-primary${scheduledDate ? ' is-active' : ''}`}
			>
				<ThemeIcon size="xs" id="calendar" />
				{renderLabel(dueDateDisplay ?? REMINDER_PICKER_COPY.editor.date)}
			</Button>

			<Button
				disabled={disabled}
				preventFocusOnPress={preventFocusOnPress}
				onClick={onOpenProjectPicker}
				data-action="toggle-picker" data-picker="project"
				aria-haspopup="dialog"
				className={`reminder-action-chip crate-semantic-token tone-secondary${selectedProject !== REMINDER_PICKER_COPY.editor.defaultProject ? ' is-active' : ''}`}
			>
				<ThemeIcon size="xs" id="folder" />
				{renderLabel(selectedProject)}
			</Button>

			<ToggleButton
				disabled={disabled}
				preventFocusOnPress={preventFocusOnPress}
				onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
				onPressedChange={onTogglePriority}
				data-action="toggle-priority"
				aria-label={priority === 1 ? 'Remove priority' : 'Set priority'}
				pressed={priority === 1}
				className={`reminder-action-chip crate-semantic-token tone-danger${priority === 1 ? ' is-active' : ''}`}
			>
				<ThemeIcon size="xs" id="flag" />
				<span className="reminder-action-label">{REMINDER_PICKER_COPY.editor.priority}</span>
			</ToggleButton>

			<Button
				disabled={disabled}
				preventFocusOnPress={preventFocusOnPress}
				onClick={onOpenRecurrencePicker}
				data-action="toggle-picker" data-picker="recurrence"
				aria-label={recurrence ? formatRecurrence(recurrence) : REMINDER_PICKER_COPY.editor.recurrenceLabel}
				aria-haspopup="dialog"
				className={`reminder-action-chip crate-semantic-token tone-warning${recurrence ? ' is-active' : ''}`}
			>
				<ThemeIcon size="xs" id="repeat" />
				<span className="reminder-action-label">{REMINDER_PICKER_COPY.editor.repeat}</span>
			</Button>
		</div>
	);
}
