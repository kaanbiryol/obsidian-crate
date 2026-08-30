import React from 'react';
import { motion } from 'framer-motion';
import { Clock, Flag, Check, Hash, Repeat } from 'lucide-react';
import { getProjectColor, type ProjectColorScheme } from '../utils/projectColors';
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
    description?: string;
    completed: boolean;
    dueDatetime?: string;
    dueDate?: string;
    priority?: number;
    project?: string;
    recurrence?: RecurrenceRule;
}

interface ReminderCardProps {
    reminder: ReminderData;
    index?: number;
    animationConfig?: AnimationConfig;
    className?: string;
    hideProject?: boolean; // Hide project tag (useful when viewing within a project)
    colorScheme?: ProjectColorScheme;
    completionPreview?: boolean;
}


/**
 * Shared reminder card using host-theme surfaces and semantic status colors.
 */
const ReminderCard: React.FC<ReminderCardProps> = ({
    reminder,
    index = 0,
    animationConfig = { enabled: true },
    className = '',
    hideProject = false,
    colorScheme = 'dark',
    completionPreview = false,
}) => {
    const dueDate = reminder.dueDatetime || reminder.dueDate;
    const isOverdue = isReminderOverdue(reminder);
    const isImportant = reminder.priority === 1;
    const isCheckboxChecked = reminder.completed || completionPreview;
    const showPriority = isImportant && !reminder.completed;

    const projectColors = reminder.project ? getProjectColor(reminder.project) : null;
    const projectThemeColors = projectColors?.[colorScheme];

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
                <button
                    type="button"
                    className={`premium-checkbox${isCheckboxChecked ? ' is-checked' : ''}${completionPreview ? ' is-completing' : ''}`}
                    role="checkbox"
                    aria-checked={isCheckboxChecked}
                    aria-disabled={completionPreview}
                    aria-label={completionPreview
                        ? `Completing ${reminder.content}`
                        : reminder.completed
                            ? `Mark ${reminder.content} incomplete`
                            : `Mark ${reminder.content} complete`}
                >
                    <span
                        className="premium-checkbox-visual"
                        style={{
                            borderColor: isCheckboxChecked
                                ? 'var(--text-success)'
                                : (isImportant
                                    ? 'var(--text-error)'
                                    : 'var(--background-modifier-border-hover, var(--background-modifier-border))'),
                            backgroundColor: isCheckboxChecked ? 'var(--text-success)' : 'transparent',
                            boxShadow: isCheckboxChecked
                                ? '0 0 6px color-mix(in srgb, var(--text-success) 35%, transparent)'
                                : isImportant
                                    ? '0 0 4px color-mix(in srgb, var(--text-error) 25%, transparent)'
                                    : 'none',
                        }}
                        aria-hidden="true"
                    >
                        {isCheckboxChecked && (
                            <Check size={12} strokeWidth={3} className="premium-checkbox-icon" />
                        )}
                    </span>
                </button>

                {/* Main content area */}
                <div className="premium-reminder-body">
                    {/* Title row */}
                    <div className="premium-reminder-title-row">
                        <span className={`premium-reminder-title ${reminder.completed ? 'is-completed' : ''}`}>
                            {renderContentWithLinks(reminder.content)}
                        </span>

                        {showPriority && (
                            <span className="premium-priority-flag" aria-label="High priority" title="High priority">
                                <Flag
                                    size={14}
                                    fill="currentColor"
                                    strokeWidth={1.5}
                                    stroke="currentColor"
                                    aria-hidden="true"
                                />
                            </span>
                        )}
                    </div>

                    {/* Description */}
                    {reminder.description && !reminder.completed && (
                        <div className="premium-reminder-description">
                            {reminder.description}
                        </div>
                    )}

                    {/* Metadata pills */}
                    {hasPills && (
                        <div className="premium-reminder-pills">
                            {/* Due date / recurrence pill */}
                            {(dueDate || reminder.recurrence) && (
                                <span
                                    className={`premium-pill ${isOverdue && !reminder.recurrence ? 'is-overdue' : ''}`}
                                    style={isOverdue && !reminder.recurrence ? {
                                        backgroundColor: 'color-mix(in srgb, var(--text-error) 12%, transparent)',
                                        color: 'var(--text-error)',
                                        borderColor: 'color-mix(in srgb, var(--text-error) 20%, transparent)',
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
                            {reminder.project && !hideProject && projectThemeColors && (
                                <span
                                    className="premium-pill premium-pill-project"
                                    style={{
                                        backgroundColor: projectThemeColors.background,
                                        color: projectThemeColors.text,
                                        borderColor: `color-mix(in srgb, ${projectThemeColors.accent} 20%, transparent)`,
                                    }}
                                >
                                    <Hash
                                        size={10}
                                        strokeWidth={2.5}
                                        style={{ color: projectThemeColors.accent, flexShrink: 0 }}
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

export { ReminderCard };
