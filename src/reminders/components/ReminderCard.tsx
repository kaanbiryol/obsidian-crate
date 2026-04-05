import React, { memo } from 'react';
import { motion } from 'framer-motion';
import { Clock, Flag, Check, Hash, Repeat } from 'lucide-react';
import { getProjectColor } from '../utils/projectColors';
import { formatDueDate, isReminderOverdue } from '../utils/dateFormatting';
import { parseMarkdownLinks, isSafeUrl } from '../utils/markdownLinks';
import type { AnimationConfig } from '../types/componentAdapter';
import type { RecurrenceRule } from '../types/reminder';

function renderContentWithLinks(content: string): React.ReactNode[] {
    const links = parseMarkdownLinks(content);
    if (links.length === 0) return [content];

    const elements: React.ReactNode[] = [];
    let lastIndex = 0;

    for (const link of links) {
        if (link.index > lastIndex) {
            elements.push(content.slice(lastIndex, link.index));
        }
        if (isSafeUrl(link.url)) {
            elements.push(
                <a
                    key={link.index}
                    href={link.url}
                    className="reminder-markdown-link"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-markdown-link="true"
                >
                    {link.text}
                </a>
            );
        } else {
            elements.push(link.text);
        }
        lastIndex = link.index + link.fullMatch.length;
    }

    if (lastIndex < content.length) {
        elements.push(content.slice(lastIndex));
    }

    return elements;
}


interface ReminderData {
    id: string;
    content: string;
    completed: boolean;
    dueDatetime?: string;
    dueDate?: string;
    priority?: number;
    project?: string;
    updated_at?: string;
    updatedAt?: string;
    recurrence?: RecurrenceRule;
}

interface ReminderCardProps {
    reminder: ReminderData;
    index?: number;
    animationConfig?: AnimationConfig;
    className?: string;
    hideProject?: boolean; // Hide project tag (useful when viewing within a project)
}


/**
 * Premium Glassmorphism Reminder Card
 * Luxury dark UI with glass effects and subtle glows
 */
const ReminderCard: React.FC<ReminderCardProps> = ({
    reminder,
    index = 0,
    animationConfig = { enabled: true },
    className = '',
    hideProject = false
}) => {
    const dueDate = reminder.dueDatetime || reminder.dueDate;
    const isOverdue = isReminderOverdue(reminder);
    const isImportant = reminder.priority === 1;

    // Get project color for accent (using dark theme colors for premium UI)
    const projectColors = reminder.project ? getProjectColor(reminder.project) : null;
    const projectAccentRgb = projectColors?.dark.accentRgb;

    // Check if we have metadata pills to display
    const hasPills = dueDate || reminder.recurrence || (reminder.project && !hideProject);

    // Wrapper component based on animation config
    const Wrapper = animationConfig.enabled ? motion.div : 'div';
    const wrapperProps = animationConfig.enabled ? {
        initial: { opacity: 0, y: 6 },
        animate: {
            opacity: 1,
            y: 0,
            transition: {
                duration: 0.4,
                delay: index * 0.04,
                ease: [0.4, 0, 0.2, 1] as const
            }
        },
        exit: {
            opacity: 0,
            x: -16,
            transition: { duration: 0.25, ease: [0.4, 0, 1, 1] as const }
        },
        whileTap: { scale: 0.985 },
    } : {};

    return (
        <Wrapper
            className={`premium-reminder-card ${reminder.completed ? 'is-completed' : ''} ${className}`}
            {...wrapperProps}
        >
            {/* Card content */}
            <div className="premium-reminder-content">
                {/* Custom checkbox */}
                <div
                    className={`premium-checkbox ${reminder.completed ? 'is-checked' : ''}`}
                    role="checkbox"
                    aria-checked={reminder.completed}
                    style={{
                        borderColor: reminder.completed ? '#22c55e' : (isImportant ? '#ef4444' : 'rgba(255,255,255,0.2)'),
                        backgroundColor: reminder.completed ? '#22c55e' : 'transparent',
                        boxShadow: reminder.completed
                            ? '0 0 6px rgba(34, 197, 94, 0.35)'
                            : isImportant
                                ? '0 0 4px rgba(239, 68, 68, 0.25)'
                                : 'none',
                    }}
                >
                    {reminder.completed && (
                        <Check size={12} strokeWidth={3} className="premium-checkbox-icon" />
                    )}
                </div>

                {/* Main content area */}
                <div className="premium-reminder-body">
                    {/* Title row */}
                    <div className="premium-reminder-title-row">
                        <span className={`premium-reminder-title ${reminder.completed ? 'is-completed' : ''}`}>
                            {renderContentWithLinks(reminder.content)}
                        </span>

                        {/* Priority flag */}
                        {isImportant && !reminder.completed && (
                            <div className="premium-priority-flag">
                                <Flag size={14} fill="currentColor" strokeWidth={1.5} stroke="currentColor" />
                            </div>
                        )}
                    </div>

                    {/* Metadata pills */}
                    {hasPills && (
                        <div className="premium-reminder-pills">
                            {/* Due date / recurrence pill */}
                            {(dueDate || reminder.recurrence) && (
                                <span
                                    className={`premium-pill ${isOverdue && !reminder.recurrence ? 'is-overdue' : ''}`}
                                    style={isOverdue && !reminder.recurrence ? {
                                        backgroundColor: 'rgba(239, 68, 68, 0.12)',
                                        color: '#ef4444',
                                        borderColor: 'rgba(239, 68, 68, 0.2)',
                                    } : undefined}
                                >
                                    {reminder.recurrence ? (
                                        <Repeat size={12} strokeWidth={2} />
                                    ) : (
                                        <Clock size={12} strokeWidth={2} />
                                    )}
                                    <span>{dueDate ? formatDueDate(dueDate) : null}</span>
                                </span>
                            )}

                            {/* Project pill */}
                            {reminder.project && !hideProject && projectColors && projectAccentRgb && (
                                <span
                                    className="premium-pill premium-pill-project"
                                    style={{
                                        backgroundColor: `rgba(${projectAccentRgb}, 0.08)`,
                                        color: projectColors.dark.accent,
                                        borderColor: `rgba(${projectAccentRgb}, 0.15)`,
                                    }}
                                >
                                    <Hash
                                        size={10}
                                        strokeWidth={2.5}
                                        style={{ color: projectColors.dark.accent, flexShrink: 0 }}
                                    />
                                    <span>{reminder.project}</span>
                                </span>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </Wrapper>
    );
};

// Memoize to prevent unnecessary re-renders
export default memo(ReminderCard, (prevProps, nextProps) => {
    const prevReminder = prevProps.reminder;
    const nextReminder = nextProps.reminder;

    return (
        prevReminder.id === nextReminder.id &&
        prevReminder.completed === nextReminder.completed &&
        prevReminder.content === nextReminder.content &&
        (prevReminder.updated_at || prevReminder.updatedAt) === (nextReminder.updated_at || nextReminder.updatedAt) &&
        prevReminder.dueDatetime === nextReminder.dueDatetime &&
        prevReminder.dueDate === nextReminder.dueDate &&
        prevReminder.priority === nextReminder.priority &&
        prevReminder.project === nextReminder.project &&
        JSON.stringify(prevReminder.recurrence) === JSON.stringify(nextReminder.recurrence) &&
        prevProps.hideProject === nextProps.hideProject
    );
});

// Also export named for backwards compatibility
export { ReminderCard };
