import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Calendar as CalendarIcon, Flag, Hash, Repeat } from 'lucide-react';
import { format } from 'date-fns';
import { ShadowDOMButton, ShadowDOMMotionButton } from '../../components/ShadowDOMButton';
import type { RecurrenceRule } from '../../types';
import { parseReminderDateValue } from '../../utils/reminderDate';
import { formatRecurrence } from '../../utils/rruleConverter';

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
    hasTime,
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
    const dueDateDisplay = dueDate
        ? parseReminderDateValue(dueDate, hasTime)
        : undefined;

    return (
        <div className="reminder-action-chips flex flex-wrap items-center mt-4 pt-3 pb-3">
            <ShadowDOMButton
                variant="light"
                onPress={onOpenDatePicker}
                className={`reminder-action-chip tone-primary flex items-center h-auto min-w-0 px-0 gap-0${dueDate ? ' is-active' : ''}`}
            >
                <motion.div
                    animate={{
                        scale: dueDateChanged && dueDate ? [1, 1.2, 1] : 1,
                        rotate: dueDateChanged && dueDate ? [0, -10, 10, 0] : 0,
                    }}
                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                >
                    <CalendarIcon
                        size={14}
                        strokeWidth={dueDate ? 2 : 1.5}
                    />
                </motion.div>
                <motion.span
                    key={dueDate || 'no-date'}
                    initial={dueDateChanged ? { opacity: 0, scale: 0.9 } : false}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
                    className="whitespace-nowrap"
                >
                    {dueDateDisplay ? format(dueDateDisplay, hasTime ? 'MMM d, HH:mm' : 'MMM d') : 'Date'}
                </motion.span>
            </ShadowDOMButton>

            <ShadowDOMButton
                variant="light"
                onPress={onOpenProjectPicker}
                className={`reminder-action-chip tone-secondary flex items-center h-auto min-w-0 px-0 gap-0${project !== defaultProject ? ' is-active' : ''}`}
            >
                <motion.div
                    animate={{
                        scale: projectChanged && project !== defaultProject ? [1, 1.2, 1] : 1,
                        rotate: projectChanged && project !== defaultProject ? [0, -10, 10, 0] : 0,
                    }}
                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                >
                    <Hash
                        size={14}
                        strokeWidth={project !== defaultProject ? 2 : 1.5}
                    />
                </motion.div>
                <motion.span
                    key={project}
                    initial={projectChanged ? { opacity: 0, scale: 0.9 } : false}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
                    className="whitespace-nowrap"
                >
                    {project || defaultProject || 'Inbox'}
                </motion.span>
            </ShadowDOMButton>

            <ShadowDOMMotionButton
                variant="light"
                onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
                onPress={onTogglePriority}
                aria-label={priority === 1 ? 'Remove priority' : 'Set priority'}
                animate={hasMounted ? {
                    scale: priority === 1 ? [1, 1.1, 1] : 1,
                } : {}}
                transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
                className={`reminder-action-chip tone-danger flex items-center h-auto min-w-0 px-0${priority === 1 ? ' is-active' : ''}`}
            >
                <motion.div
                    animate={hasMounted ? {
                        scale: priority === 1 ? [1, 1.2, 1] : 1,
                        rotate: priority === 1 ? [0, -10, 10, 0] : 0
                    } : {}}
                    transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
                >
                    <Flag
                        size={14}
                        strokeWidth={1.5}
                        fill={priority === 1 ? 'currentColor' : 'none'}
                        stroke="currentColor"
                    />
                </motion.div>
                <span className="reminder-action-label">Priority</span>
            </ShadowDOMMotionButton>

            <ShadowDOMMotionButton
                variant="light"
                onPress={onOpenRecurrencePicker}
                layout={hasMounted}
                animate={hasMounted ? { scale: recurrence ? [1, 1.02, 1] : 1 } : {}}
                transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                className={`reminder-action-chip tone-warning flex items-center h-auto min-w-0 px-0 gap-0${recurrence ? ' is-active' : ''}`}
            >
                <motion.div
                    animate={hasMounted ? { rotate: recurrence ? 360 : 0 } : {}}
                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                >
                    <Repeat size={14} strokeWidth={1.5} />
                </motion.div>
                <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                        key={recurrence ? 'recurrence-value' : 'recurrence-label'}
                        initial={hasMounted ? { opacity: 0, width: 0, x: -8 } : false}
                        animate={{ opacity: 1, width: 'auto', x: 0 }}
                        exit={{ opacity: 0, width: 0, x: -8 }}
                        transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                        className="reminder-action-label"
                    >
                        {recurrence ? formatRecurrence(recurrence) : 'Repeat'}
                    </motion.span>
                </AnimatePresence>
            </ShadowDOMMotionButton>
        </div>
    );
}
