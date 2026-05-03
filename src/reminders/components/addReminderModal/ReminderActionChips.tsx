import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Calendar as CalendarIcon, Flag, Hash, Repeat } from 'lucide-react';
import { format } from 'date-fns';
import { ShadowDOMButton, ShadowDOMMotionButton } from '../ShadowDOMButton';
import type { RecurrenceRule } from '../../types';
import { parseReminderDateValue } from '../../utils/reminderDate';
import { formatRecurrence } from '../../utils/rruleConverter';

const getPillStyle = (
    isActive: boolean,
    colorName: 'primary' | 'secondary' | 'danger' | 'warning',
    isDark: boolean
): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
        padding: '8px 12px',
        gap: '6px',
        lineHeight: 1,
        height: '36px',
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: '12px',
        fontSize: '13px',
        fontWeight: 500,
        letterSpacing: '0.005em',
        transition: 'all 0.2s ease-out',
    };

    if (isActive) {
        return {
            ...baseStyle,
            backgroundColor: isDark
                ? `hsl(var(--heroui-${colorName}) / 0.12)`
                : `hsl(var(--heroui-${colorName}) / 0.08)`,
            color: `hsl(var(--heroui-${colorName}))`,
            border: `1px solid hsl(var(--heroui-${colorName}) / 0.18)`,
            boxShadow: isDark
                ? '0 1px 3px rgba(0, 0, 0, 0.2)'
                : '0 1px 2px rgba(0, 0, 0, 0.05)',
        };
    }

    return {
        ...baseStyle,
        backgroundColor: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)',
        color: isDark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.45)',
        border: '1px solid transparent',
    };
};

interface ReminderActionChipsProps {
    isDark: boolean;
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
    isDark,
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
        <div
            className="flex flex-wrap items-center mt-4 pt-3 pb-3"
            style={{
                gap: '10px',
                borderTop: isDark
                    ? '1px solid rgba(255, 255, 255, 0.05)'
                    : '1px solid rgba(0, 0, 0, 0.04)',
            }}
        >
            <ShadowDOMButton
                variant="light"
                onPress={onOpenDatePicker}
                className="flex items-center h-auto min-w-0 px-0 gap-0"
                style={getPillStyle(!!dueDate, 'primary', isDark)}
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
                className="flex items-center h-auto min-w-0 px-0 gap-0"
                style={getPillStyle(project !== defaultProject, 'secondary', isDark)}
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
                isIconOnly
                onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
                onPress={onTogglePriority}
                animate={hasMounted ? {
                    scale: priority === 1 ? [1, 1.1, 1] : 1,
                } : {}}
                transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
                className="flex items-center h-auto min-w-0 px-0"
                style={getPillStyle(priority === 1, 'danger', isDark)}
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
            </ShadowDOMMotionButton>

            <ShadowDOMMotionButton
                variant="light"
                onPress={onOpenRecurrencePicker}
                layout={hasMounted}
                animate={hasMounted ? { scale: recurrence ? [1, 1.02, 1] : 1 } : {}}
                transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                className="flex items-center h-auto min-w-0 px-0 gap-0"
                style={getPillStyle(!!recurrence, 'warning', isDark)}
            >
                <motion.div
                    animate={hasMounted ? { rotate: recurrence ? 360 : 0 } : {}}
                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                >
                    <Repeat size={14} strokeWidth={1.5} />
                </motion.div>
                <AnimatePresence mode="popLayout">
                    {recurrence && (
                        <motion.span
                            key="recurrence-value"
                            initial={hasMounted ? { opacity: 0, width: 0, x: -8 } : false}
                            animate={{ opacity: 1, width: 'auto', x: 0 }}
                            exit={{ opacity: 0, width: 0, x: -8 }}
                            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                        >
                            {formatRecurrence(recurrence)}
                        </motion.span>
                    )}
                </AnimatePresence>
            </ShadowDOMMotionButton>
        </div>
    );
}
