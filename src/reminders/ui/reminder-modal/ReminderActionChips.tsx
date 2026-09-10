import React from 'react';
import { Button } from '../../../ui/shared/Button';
import { ThemeIcon } from '../../components/theme-icon';
import type { RecurrenceRule } from '../../types';
import { formatRecurrence } from '../../utils/rruleConverter';
import { formatDueDate } from '../../utils/dateFormatting';
import { REMINDER_PICKER_COPY } from './pickerCopy';
import { useReminderClock } from '../useReminderClock';
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
    animateLabels = false,
    onOpenDatePicker,
    onOpenProjectPicker,
    onOpenRecurrencePicker,
    onTogglePriority,
}: ReminderActionChipsProps) {
    const clock = useReminderClock();
    const dueDateDisplay = dueDateLabel ?? formatDueDate(dueDate ?? undefined, undefined, clock.now);
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
                className={`reminder-action-chip crate-semantic-token tone-primary${dueDate ? ' is-active' : ''}`}
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
                className={`reminder-action-chip crate-semantic-token tone-secondary${project !== defaultProject ? ' is-active' : ''}`}
            >
                <ThemeIcon size="xs" id="folder" />
                {renderLabel(project || defaultProject || REMINDER_PICKER_COPY.editor.defaultProject)}
            </Button>

            <Button
                disabled={disabled}
                preventFocusOnPress={preventFocusOnPress}
                onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
                onClick={onTogglePriority}
                data-action="toggle-priority"
                aria-label={priority === 1 ? 'Remove priority' : 'Set priority'}
                aria-pressed={priority === 1}
                className={`reminder-action-chip crate-semantic-token tone-danger${priority === 1 ? ' is-active' : ''}`}
            >
                <ThemeIcon size="xs" id="flag" />
                <span className="reminder-action-label">{REMINDER_PICKER_COPY.editor.priority}</span>
            </Button>

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
