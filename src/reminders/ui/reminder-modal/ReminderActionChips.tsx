import React from 'react';
import { ShadowDOMButton } from '../../components/ShadowDOMButton';
import { ObsidianIcon } from '../../components/obsidian-icon';
import type { RecurrenceRule } from '../../types';
import { formatRecurrence } from '../../utils/rruleConverter';
import { formatDueDate } from '../../utils/dateFormatting';
import { REMINDER_PICKER_COPY } from './pickerCopy';

interface ReminderActionChipsProps {
    dueDate: string | null;
    hasTime?: boolean;
    project: string;
    defaultProject: string;
    priority: number;
    recurrence?: RecurrenceRule;
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
    onOpenDatePicker,
    onOpenProjectPicker,
    onOpenRecurrencePicker,
    onTogglePriority,
}: ReminderActionChipsProps) {
    const dueDateDisplay = formatDueDate(dueDate ?? undefined);

    return (
        <div className="reminder-action-chips">
            <ShadowDOMButton
                variant="light"
                onPress={onOpenDatePicker}
                aria-haspopup="dialog"
                className={`reminder-action-chip tone-primary${dueDate ? ' is-active' : ''}`}
            >
                <ObsidianIcon size="xs" id="calendar" />
                <span className="reminder-action-label">
                    {dueDateDisplay ?? REMINDER_PICKER_COPY.editor.date}
                </span>
            </ShadowDOMButton>

            <ShadowDOMButton
                variant="light"
                onPress={onOpenProjectPicker}
                aria-haspopup="dialog"
                className={`reminder-action-chip tone-secondary${project !== defaultProject ? ' is-active' : ''}`}
            >
                <ObsidianIcon size="xs" id="hash" />
                <span className="reminder-action-label">
                    {project || defaultProject || REMINDER_PICKER_COPY.editor.defaultProject}
                </span>
            </ShadowDOMButton>

            <ShadowDOMButton
                variant="light"
                onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
                onPress={onTogglePriority}
                aria-label={priority === 1 ? 'Remove priority' : 'Set priority'}
                aria-pressed={priority === 1}
                className={`reminder-action-chip tone-danger${priority === 1 ? ' is-active' : ''}`}
            >
                <ObsidianIcon size="xs" id="flag" />
                <span className="reminder-action-label">{REMINDER_PICKER_COPY.editor.priority}</span>
            </ShadowDOMButton>

            <ShadowDOMButton
                variant="light"
                onPress={onOpenRecurrencePicker}
                aria-label={recurrence ? formatRecurrence(recurrence) : REMINDER_PICKER_COPY.editor.recurrenceLabel}
                aria-haspopup="dialog"
                className={`reminder-action-chip tone-warning${recurrence ? ' is-active' : ''}`}
            >
                <ObsidianIcon size="xs" id="repeat" />
                <span className="reminder-action-label">{REMINDER_PICKER_COPY.editor.repeat}</span>
            </ShadowDOMButton>
        </div>
    );
}
