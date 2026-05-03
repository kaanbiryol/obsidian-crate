import React, { useRef, useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Calendar as CalendarIcon, Flag, Hash, Repeat } from 'lucide-react';
import { format } from 'date-fns';

import { RichTextInput, RichTextInputHandle } from '../RichTextInput';
import { ShadowDOMButton, ShadowDOMMotionButton } from '../ShadowDOMButton';
import { ProjectAutocompleteDropdown } from '../ProjectAutocompleteDropdown';
import { useProjectAutocomplete } from '../useProjectAutocomplete';
import { formatRecurrence } from '../../utils/rruleConverter';

/**
 * Track whether a scrollable element has content below the visible area.
 * Returns true when the element overflows and isn't scrolled to the bottom.
 */
function useBottomFade(ref: React.RefObject<HTMLElement | null>): boolean {
    const [show, setShow] = useState(false);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const update = () => {
            const overflows = el.scrollHeight > el.clientHeight + 1;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
            setShow(overflows && !atBottom);
        };

        update();
        el.addEventListener('scroll', update, { passive: true });
        el.addEventListener('input', update);
        const ro = new ResizeObserver(update);
        ro.observe(el);

        return () => {
            el.removeEventListener('scroll', update);
            el.removeEventListener('input', update);
            ro.disconnect();
        };
    }, [ref]);

    return show;
}

const FADE_MASK = 'linear-gradient(to bottom, black calc(100% - 40px), transparent)';
const NO_FADE: React.CSSProperties = {};
const FADE_STYLE: React.CSSProperties = {
    maskImage: FADE_MASK,
    WebkitMaskImage: FADE_MASK,
};
import { getFontSize } from '../../ui/themes';
import { RecurrenceRule } from '../../types';
import { parseReminderDateValue } from '../../utils/reminderDate';

// Helper to generate pill styles using HeroUI CSS variables
// Refined glass pill design with subtle borders and minimal shadows (no glows)
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

interface AddReminderModalBodyProps {
    isEditing: boolean;
    isDark: boolean;
    textColor: string;
    content: string;
    onContentChange: (value: string) => void;
    description: string;
    onDescriptionChange: (value: string) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    allowAutoFocus: boolean;
    preserveSelection: boolean;
    projects: string[];
    textareaRef: React.RefObject<HTMLDivElement | null>;
    richTextInputRef: React.RefObject<RichTextInputHandle | null>;
    onTouchEnd: () => void;
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

export const AddReminderModalBody: React.FC<AddReminderModalBodyProps> = ({
    isEditing,
    isDark,
    textColor,
    content,
    onContentChange,
    description,
    onDescriptionChange,
    onKeyDown,
    allowAutoFocus,
    preserveSelection,
    projects,
    textareaRef,
    richTextInputRef,
    onTouchEnd,
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
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const descriptionRef = useRef<HTMLTextAreaElement>(null);
    const titleFade = useBottomFade(textareaRef);
    const descFade = useBottomFade(descriptionRef);

    // Auto-size description textarea on mount when editing existing content
    useEffect(() => {
        const el = descriptionRef.current;
        if (el && description) {
            el.setCssProps({ height: 'auto' });
            el.setCssProps({ height: `${Math.min(el.scrollHeight, 120)}px` });
        }
    }, []);

    const dueDateDisplay = dueDate
        ? parseReminderDateValue(dueDate, hasTime)
        : undefined;

    const autocomplete = useProjectAutocomplete({
        content,
        projects,
        onContentChange,
        richTextInputRef,
    });

    const handleAutocompleteQuery = useCallback((query: string | null, rect: DOMRect | null) => {
        autocomplete.updateAutocomplete(query, rect);
    }, [autocomplete.updateAutocomplete]);

    return (
    <div className="px-5 pt-3 pb-3" onTouchEnd={onTouchEnd}>
        {/* Text Input - wrapped in subtle glass container */}
        <div
            ref={containerRef}
            className="relative rounded-lg"
            style={{
                backgroundColor: isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.02)',
                border: isDark ? '1px solid rgba(255, 255, 255, 0.04)' : '1px solid rgba(0, 0, 0, 0.03)',
                padding: '12px 14px',
            }}
        >
            <RichTextInput
                ref={richTextInputRef}
                value={content}
                onChange={onContentChange}
                onKeyDown={onKeyDown}
                placeholder={isEditing ? "Edit your reminder..." : "What do you need to remember?"}
                inputRef={textareaRef}
                autoFocus={allowAutoFocus}
                preserveSelection={preserveSelection}
                knownProjects={projects}
                onAutocompleteQuery={handleAutocompleteQuery}
                onAutocompleteKeyDown={autocomplete.handleKeyDown}
                className="w-full px-0 py-0 bg-transparent border-none outline-none resize-none min-h-[32px] ios-scroll"
                style={{ fontSize: getFontSize('lg'), color: textColor, maxHeight: '100px', overflowY: 'auto', ...(titleFade ? FADE_STYLE : NO_FADE) }}
            />
            {autocomplete.isOpen && (
                <ProjectAutocompleteDropdown
                    filteredProjects={autocomplete.filteredProjects}
                    highlightedIndex={autocomplete.highlightedIndex}
                    anchorRect={autocomplete.rect}
                    containerRef={containerRef}
                    isDark={isDark}
                    onSelect={autocomplete.selectProject}
                />
            )}

            {/* Description - inside glass container, separated by subtle divider */}
            <div
                style={{
                    marginTop: '8px',
                    paddingTop: '8px',
                    borderTop: isDark
                        ? '1px solid rgba(255, 255, 255, 0.04)'
                        : '1px solid rgba(0, 0, 0, 0.04)',
                }}
            >
                <textarea
                    ref={descriptionRef}
                    value={description}
                    onChange={(e) => onDescriptionChange(e.target.value)}
                    placeholder="Add description..."
                    rows={1}
                    className="ios-scroll focus:outline-none focus:ring-0 focus:shadow-none"
                    style={{
                        display: 'block',
                        width: '100%',
                        padding: 0,
                        background: 'transparent',
                        border: 'none',
                        outline: 'none',
                        boxShadow: 'none',
                        WebkitAppearance: 'none',
                        resize: 'none',
                        fontSize: '13px',
                        lineHeight: 1.5,
                        color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)',
                        caretColor: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)',
                        fontFamily: 'inherit',
                        maxHeight: '120px',
                        overflowY: 'auto',
                        ...(descFade ? FADE_STYLE : NO_FADE),
                    }}
                    onInput={(e) => {
                        const el = e.currentTarget;
                        el.setCssProps({ height: 'auto' });
                        el.setCssProps({ height: `${Math.min(el.scrollHeight, 120)}px` });
                    }}
                />
            </div>
        </div>

        {/* Action Buttons - Compact Inline Chips */}
        <div
            className="flex flex-wrap items-center mt-4 pt-3 pb-3"
            style={{
                gap: '10px',
                borderTop: isDark
                    ? '1px solid rgba(255, 255, 255, 0.05)'
                    : '1px solid rgba(0, 0, 0, 0.04)',
            }}
        >
            {/* Date Pill - Opens full-screen date picker modal */}
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

            {/* Project Pill - Opens full-screen project picker modal */}
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

            {/* Important Pill - Toggle directly (no modal needed) */}
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

            {/* Repeat Pill - Opens full-screen recurrence picker modal */}
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
    </div>
    );
};
