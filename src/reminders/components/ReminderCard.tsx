import React from 'react';
import { motion } from 'framer-motion';
import { ThemeIcon } from './theme-icon';
import { getProjectColor, type ProjectColorScheme } from '../utils/projectColors';
import { formatDueDate, isReminderOverdue } from '../utils/dateFormatting';
import { parseMarkdownLinks, isSafeUrl } from '../utils/markdownLinks';
import { readableWikiLinks } from '../utils/readableWikiLinks';
import type { AnimationConfig } from '../types/componentAdapter';
import type { RecurrenceRule } from '../types/reminder';
import { useObsidianReducedMotion } from '../ui/useObsidianReducedMotion';
import { useReminderClock } from '../ui/useReminderClock';

function renderContentWithLinks(content: string): React.ReactNode[] {
    const links = parseMarkdownLinks(content);
    if (links.length === 0) return [readableWikiLinks(content)];

    const elements: React.ReactNode[] = [];
    let lastIndex = 0;

    for (const link of links) {
        if (link.index > lastIndex) {
            elements.push(readableWikiLinks(content.slice(lastIndex, link.index)));
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
        elements.push(readableWikiLinks(content.slice(lastIndex)));
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
    const animationsEnabled = animationConfig.enabled && !useObsidianReducedMotion();
    const trackedReminders = React.useMemo(() => [reminder], [reminder]);
    const clock = useReminderClock(trackedReminders);
    const dueDate = reminder.dueDatetime || reminder.dueDate;
    const isOverdue = isReminderOverdue(reminder, clock.now);
    const isImportant = reminder.priority === 1;
    const isCheckboxChecked = reminder.completed || completionPreview;
    const showPriority = isImportant && !reminder.completed;

    const projectColors = reminder.project ? getProjectColor(reminder.project) : null;
    const projectThemeColors = projectColors?.[colorScheme];

    // Check if we have metadata pills to display
    const hasPills = dueDate || reminder.recurrence || (reminder.project && !hideProject);

    // Wrapper component based on animation config
    const Wrapper = animationsEnabled ? motion.div : 'div';
    const wrapperProps = animationsEnabled ? {
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
                    className={`premium-checkbox${isCheckboxChecked ? ' is-checked' : ''}${isImportant ? ' is-important' : ''}${completionPreview ? ' is-completing' : ''}`}
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
                        aria-hidden="true"
                    >
                        {isCheckboxChecked && (
                            <ThemeIcon size="xs" id="check" className="premium-checkbox-icon" />
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
                                <ThemeIcon
                                    size="xs"
                                    id="flag"
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
                                >
                                    {reminder.recurrence ? (
                                        <ThemeIcon size="xs" id="repeat" />
                                    ) : (
                                        <ThemeIcon size="xs" id="calendar" />
                                    )}
                                    <span>{dueDate ? formatDueDate(dueDate, undefined, clock.now) : null}</span>
                                </span>
                            )}

                            {/* Project pill */}
                            {reminder.project && !hideProject && projectThemeColors && (
                                <span
                                    className="premium-pill premium-pill-project"
                                    style={{
                                        backgroundColor: `var(--crate-card-project-bg, ${projectThemeColors.background})`,
                                        color: `var(--crate-card-project-text, ${projectThemeColors.text})`,
                                        borderColor: `var(--crate-card-project-border, color-mix(in srgb, ${projectThemeColors.accent} 20%, transparent))`,
                                    }}
                                >
                                    <ThemeIcon
                                        size="xs"
                                        id="folder"
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
