import React from 'react';
import { motion } from 'framer-motion';
import { ShadowDOMButton, ShadowDOMMotionButton } from '../../components/ShadowDOMButton';
import { ObsidianIcon } from '../../components/obsidian-icon';
import type { RecurrenceRule } from '../../types';
import { formatRecurrence } from '../../utils/rruleConverter';
import { formatDueDate } from '../../utils/dateFormatting';
import { REMINDER_PICKER_COPY } from './pickerCopy';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';

interface ReminderActionChipsProps {
    dueDate: string | null;
    hasTime?: boolean;
    project: string;
    defaultProject: string;
    priority: number;
    recurrence?: RecurrenceRule;
    dueDateChanged: boolean;
    projectChanged: boolean;
    hasMounted: boolean;
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
    dueDateChanged,
    projectChanged,
    hasMounted,
    onOpenDatePicker,
    onOpenProjectPicker,
    onOpenRecurrencePicker,
    onTogglePriority,
}: ReminderActionChipsProps) {
    const reduceMotion = useObsidianReducedMotion();
    const dueDateDisplay = formatDueDate(dueDate ?? undefined);

    return (
        <div className="reminder-action-chips flex flex-wrap items-center mt-4 pt-3 pb-3">
            <ShadowDOMButton
                variant="light"
                onPress={onOpenDatePicker}
                className={`reminder-action-chip tone-primary flex items-center h-auto min-w-0 px-0 gap-0${dueDate ? ' is-active' : ''}`}
            >
                <motion.div
                    animate={reduceMotion ? undefined : {
                        scale: dueDateChanged && dueDate ? [1, 1.2, 1] : 1,
                        rotate: dueDateChanged && dueDate ? [0, -10, 10, 0] : 0,
                    }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                >
                    <ObsidianIcon size="s" id="calendar" />
                </motion.div>
                <motion.span
                    key={dueDate || 'no-date'}
                    initial={!reduceMotion && dueDateChanged ? { opacity: 0, scale: 0.9 } : false}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
                    className="whitespace-nowrap"
                >
                    {dueDateDisplay ?? REMINDER_PICKER_COPY.editor.date}
                </motion.span>
            </ShadowDOMButton>

            <ShadowDOMButton
                variant="light"
                onPress={onOpenProjectPicker}
                className={`reminder-action-chip tone-secondary flex items-center h-auto min-w-0 px-0 gap-0${project !== defaultProject ? ' is-active' : ''}`}
            >
                <motion.div
                    animate={reduceMotion ? undefined : {
                        scale: projectChanged && project !== defaultProject ? [1, 1.2, 1] : 1,
                        rotate: projectChanged && project !== defaultProject ? [0, -10, 10, 0] : 0,
                    }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                >
                    <ObsidianIcon size="s" id="hash" />
                </motion.div>
                <motion.span
                    key={project}
                    initial={!reduceMotion && projectChanged ? { opacity: 0, scale: 0.9 } : false}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
                    className="whitespace-nowrap"
                >
                    {project || defaultProject || REMINDER_PICKER_COPY.editor.defaultProject}
                </motion.span>
            </ShadowDOMButton>

            <ShadowDOMMotionButton
                variant="light"
                onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
                onPress={onTogglePriority}
                aria-label={priority === 1 ? 'Remove priority' : 'Set priority'}
                animate={hasMounted && !reduceMotion ? {
                    scale: priority === 1 ? [1, 1.1, 1] : 1,
                } : {}}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
                className={`reminder-action-chip tone-danger flex items-center h-auto min-w-0 px-0${priority === 1 ? ' is-active' : ''}`}
            >
                <motion.div
                    animate={hasMounted && !reduceMotion ? {
                        scale: priority === 1 ? [1, 1.2, 1] : 1,
                        rotate: priority === 1 ? [0, -10, 10, 0] : 0
                    } : {}}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
                >
                    <ObsidianIcon size="s" id="flag" />
                </motion.div>
                <span className="reminder-action-label">{REMINDER_PICKER_COPY.editor.priority}</span>
            </ShadowDOMMotionButton>

            <ShadowDOMMotionButton
                variant="light"
                onPress={onOpenRecurrencePicker}
                aria-label={recurrence ? formatRecurrence(recurrence) : REMINDER_PICKER_COPY.editor.recurrenceLabel}
                layout={hasMounted && !reduceMotion}
                animate={hasMounted && !reduceMotion ? { scale: recurrence ? [1, 1.02, 1] : 1 } : {}}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                className={`reminder-action-chip tone-warning flex items-center h-auto min-w-0 px-0 gap-0${recurrence ? ' is-active' : ''}`}
            >
                <motion.div
                    animate={hasMounted && !reduceMotion ? { rotate: recurrence ? 360 : 0 } : {}}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                >
                    <ObsidianIcon size="s" id="repeat" />
                </motion.div>
                <span className="reminder-action-label">{REMINDER_PICKER_COPY.editor.repeat}</span>
            </ShadowDOMMotionButton>
        </div>
    );
}
