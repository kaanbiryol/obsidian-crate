import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { format } from 'date-fns';

import type { RichTextInputHandle } from './RichTextInput';
import { BaseModal } from './BaseModal';
import { ModalBackdrop } from './ModalBackdrop';
import { DeleteConfirmationModal } from './DeleteConfirmationModal';
import { AddReminderModalBody } from './addReminderModal/AddReminderModalBody';
import { AddReminderModalHeader } from './addReminderModal/AddReminderModalHeader';
import { DatePickerModal } from './addReminderModal/DatePickerModal';
import { ProjectPickerModal } from './addReminderModal/ProjectPickerModal';
import { RecurrencePickerModal } from './addReminderModal/RecurrencePickerModal';
import { recurrenceToText } from '../utils/rruleConverter';
import { parseReminderContent } from '../utils/reminderParser';
import { moveCursorToEnd } from '../utils/cursorPosition';
import { AnimationConfig } from '../ui/animations';
import { Reminder, RecurrenceRule } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('AddReminderModal');

interface AddReminderModalProps {
    onClose: () => void;
    onAdd?: (content: string, project: string, priority: number, dueDate?: string, recurrence?: RecurrenceRule) => Promise<void>;
    onSave?: (reminder: any) => Promise<void>;
    onDelete?: (reminder: any) => Promise<void>;
    onError?: (error: Error) => void;
    reminder?: Reminder;
    projects?: string[];
    defaultProject?: string;
    initialDueDate?: string;
    animationConfig?: AnimationConfig;
    variant?: 'bottom-sheet' | 'centered';
    showBackdrop?: boolean;
    optimistic?: boolean; // If true, close modal immediately and handle errors via onError callback
    /**
     * Controls how picker modals (date, project, recurrence) are displayed:
     * - 'replace' (default): Main modal is hidden when picker opens
     * - 'overlay': Main modal stays visible, picker opens as centered modal on top
     */
    pickerMode?: 'replace' | 'overlay';
    /**
     * Keyboard offset in pixels - used to position modal above on-screen keyboard on mobile.
     * When set, the modal container's bottom will be offset by this amount.
     */
    keyboardOffset?: number;
}

export const AddReminderModal: React.FC<AddReminderModalProps> = ({
    onClose,
    onAdd,
    onSave,
    onDelete,
    onError,
    reminder,
    projects = [],
    defaultProject = 'Inbox',
    initialDueDate,
    animationConfig = { enabled: true },
    variant = 'bottom-sheet',
    showBackdrop = true,
    optimistic = true,
    pickerMode = 'replace',
    keyboardOffset = 0,
}) => {
    const isEditing = !!reminder;
    const isMobileSheet = variant === 'bottom-sheet';
    const focusDelayMs = isMobileSheet ? (isEditing ? 0 : 120) : 0;

    const initialContent = useMemo(() => {
        if (!reminder) return '';

        let reconstructed = reminder.content || '';

        // Order: date/recurrence → project → priority (matches plugin display order)
        // Date and recurrence are mutually exclusive - recurrence takes priority

        if (reminder.recurrence) {
            // Add recurrence if present
            const recurrenceText = recurrenceToText(reminder.recurrence);
            reconstructed += ` ${recurrenceText}`;
        } else {
            // Add date only if NO recurrence (they're mutually exclusive)
            const effectiveDate = reminder.dueDatetime || reminder.dueDate || initialDueDate;
            if (effectiveDate) {
                const dateStr = format(new Date(effectiveDate), 'MMM d, yyyy HH:mm');
                reconstructed += ` ${dateStr}`;
            }
        }

        // Add project tag if not default/Inbox (matches rebuildContentInOrder logic)
        if (reminder.project && reminder.project !== defaultProject && reminder.project !== 'Inbox') {
            reconstructed += ` #${reminder.project}`;
        }

        // Add priority marker if important
        if (reminder.priority === 1) {
            reconstructed += ' !';
        }

        return reconstructed.trim();
    }, [reminder, defaultProject, initialDueDate]);

    const [content, setContent] = useState(() => initialContent);
    const [project, setProject] = useState((reminder?.project && String(reminder.project).trim()) || defaultProject || 'Inbox');
    const [priority, setPriority] = useState(reminder?.priority || 4);
    // Don't initialize dueDate from reminder if it has recurrence (they're mutually exclusive)
    const [dueDate, setDueDate] = useState<string | null>(
        reminder?.recurrence ? null : (reminder?.dueDatetime || reminder?.dueDate || initialDueDate || null)
    );
    const textareaRef = useRef<HTMLDivElement>(null);
    const richTextInputRef = useRef<RichTextInputHandle>(null);
    const [isUpdatingFromButtons, setIsUpdatingFromButtons] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [recurrence, setRecurrence] = useState<RecurrenceRule | undefined>(reminder?.recurrence);
    // Track whether recurrence/date were set from text parsing (vs picker buttons)
    // Used to decide if we should auto-clear when parser no longer detects them
    const recurrenceSetFromText = useRef(false);
    const dueDateSetFromText = useRef(false);
    // Sequential modal transitions - only one view visible at a time
    // When switching from main -> picker, main animates out first, then picker animates in
    const [currentView, setCurrentView] = useState<'main' | 'date' | 'project' | 'recurrence' | null>('main');
    // Track closing state for exit animation
    const [isClosing, setIsClosing] = useState(false);
    // Track modal visibility separately for delayed slide animation
    const [showModal, setShowModal] = useState(true);
    // Track when entry animation completes - used to defer focus on mobile edit mode
    const [isEntryAnimationComplete, setIsEntryAnimationComplete] = useState(false);

    // Duration for close animation
    const CLOSE_ANIMATION_DURATION = 200; // ms

    // Simplified close handler - single state update + timeout
    // Avoids multiple re-renders from three-phase orchestration
    const handleClose = useCallback(() => {
        if (isClosing) return; // Prevent double-close

        // Blur input to trigger keyboard dismissal
        richTextInputRef.current?.blur();

        // Single state update for both backdrop fade and modal slide
        setIsClosing(true);
        setShowModal(false);

        // Complete - call onClose after animation
        setTimeout(onClose, CLOSE_ANIMATION_DURATION);
    }, [isClosing, onClose]);

    // Helper to transition to picker views
    // Main modal stays mounted (hidden via visibility), picker modals animate in
    const transitionToView = useCallback((targetView: 'main' | 'date' | 'project' | 'recurrence') => {
        setCurrentView(targetView);
    }, []);
    // Helper to close picker modal and return to main view
    const closePickerModal = useCallback(() => {
        setCurrentView('main');
        // Use queueMicrotask for focus - runs after React commit but before paint
        // This is lighter than flushSync + rAF and still works for iOS keyboard
        queueMicrotask(() => {
            richTextInputRef.current?.focus();
        });
    }, []);

    // Track if component has mounted - used to prevent animations on initial render
    const hasMounted = useRef(false);
    // Track previous values to only animate on actual changes (not just on hasMounted becoming true)
    const prevDueDateRef = useRef(dueDate);
    const prevProjectRef = useRef(project);
    // Defer auto-focus on mobile to avoid jank during initial sheet animation/keyboard open
    const [allowAutoFocus, setAllowAutoFocus] = useState(focusDelayMs === 0);

    // Track if the initial content had a date - used to detect when user removes it
    const initialContentHadDate = useMemo(() => {
        const parsed = parseReminderContent(initialContent, projects);
        return !!parsed.dueDate;
    }, [initialContent, projects]);

    useEffect(() => {
        // Set after a short delay to ensure initial render is complete
        const timer = setTimeout(() => {
            hasMounted.current = true;
        }, 50);
        return () => clearTimeout(timer);
    }, []);

    // Compute if values actually changed (for animation purposes)
    const dueDateChanged = hasMounted.current && prevDueDateRef.current !== dueDate;
    const projectChanged = hasMounted.current && prevProjectRef.current !== project;

    // Update refs after render to track changes for next render
    useEffect(() => {
        prevDueDateRef.current = dueDate;
        prevProjectRef.current = project;
    });

    useEffect(() => {
        if (focusDelayMs === 0) {
            setAllowAutoFocus(true);
            return;
        }
        setAllowAutoFocus(false);
        const timer = setTimeout(() => {
            setAllowAutoFocus(true);
        }, focusDelayMs);
        return () => clearTimeout(timer);
    }, [focusDelayMs]);

    // Ensure project is always initialized on mount (especially for new reminders)
    useEffect(() => {
        if (!isEditing) {
            const currentProject = String(project || '').trim();
            if (!currentProject) {
                const safeDefault = defaultProject || 'Inbox';
                setProject(safeDefault);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Run only once on mount

    // Reset animation states when modal opens (for component reuse)
    useEffect(() => {
        setIsClosing(false);
        setShowModal(true);
        setIsEntryAnimationComplete(false);
    }, []);

    // Callback for when modal entry animation completes
    const handleEntryAnimationComplete = useCallback(() => {
        setIsEntryAnimationComplete(true);
    }, []);

    const textColor = 'var(--text-normal)';
    const keyboardPadding = keyboardOffset > 0 ? Math.max(0, keyboardOffset - 32) : 0;

    // Detect dark mode for input/dropdown styling
    const isDark = document.body.classList.contains('theme-dark');

    // Helper to rebuild content in a fixed order: [user text] [date/recurrence] [#tag] [!]
    // This ensures elements stay in consistent positions regardless of modification order
    // Note: We preserve user-typed tags here so they remain visible in Obsidian
    const rebuildContentInOrder = useCallback((
        cleanText: string,
        date: string | null,
        rec: RecurrenceRule | undefined,
        proj: string,
        prio: number
    ): string => {
        let result = cleanText.trim();

        // 1. Add recurrence OR date (recurrence takes priority - mutually exclusive)
        if (rec) {
            const recurrenceText = recurrenceToText(rec);
            result += ` ${recurrenceText}`;
        } else if (date) {
            const dateStr = format(new Date(date), 'MMM d, yyyy HH:mm');
            result += ` ${dateStr}`;
        }

        // 2. Preserve user-typed tag (so Obsidian renders it normally)
        // This only adds the tag back if user typed one - we don't auto-add project tags
        if (proj && proj !== defaultProject && proj !== 'Inbox') {
            result += ` #${proj}`;
        }

        // 3. Add priority marker (if important)
        if (prio === 1) {
            result += ' !';
        }

        // 4. Always add trailing space for cursor visibility
        result += ' ';

        return result;
    }, [defaultProject]);

    type ContentUpdate = {
        dueDate?: string | null;
        recurrence?: RecurrenceRule | null;
        project?: string;
        priority?: number;
    };

    type UpdateOptions = {
        mode?: 'timeout' | 'raf';
        delayMs?: number;
        afterUpdate?: () => void;
    };

    const finalizeUpdate = (options?: UpdateOptions) => {
        const mode = options?.mode ?? 'timeout';
        const delayMs = options?.delayMs ?? 100;
        const complete = () => {
            setIsUpdatingFromButtons(false);
            options?.afterUpdate?.();
        };
        if (mode === 'raf') {
            requestAnimationFrame(() => {
                requestAnimationFrame(complete);
            });
            return;
        }
        setTimeout(complete, delayMs);
    };

    const applyContentUpdate = useCallback((next: ContentUpdate, options?: UpdateOptions) => {
        setIsUpdatingFromButtons(true);
        const parsed = parseReminderContent(content, projects);
        const cleanText = parsed.cleanContent ?? content.trim();

        const nextDueDate = next.dueDate !== undefined ? next.dueDate : dueDate;
        const nextRecurrence = next.recurrence !== undefined ? (next.recurrence ?? undefined) : recurrence;
        const nextProject = next.project !== undefined ? next.project : project;
        const nextPriority = next.priority !== undefined ? next.priority : priority;

        if (next.dueDate !== undefined) {
            setDueDate(next.dueDate);
        }
        if (next.recurrence !== undefined) {
            setRecurrence(next.recurrence ?? undefined);
        }
        if (next.project !== undefined) {
            setProject(next.project);
        }
        if (next.priority !== undefined) {
            setPriority(next.priority as any);
        }

        setContent(rebuildContentInOrder(cleanText, nextDueDate, nextRecurrence, nextProject, nextPriority));
        finalizeUpdate(options);
    }, [content, dueDate, recurrence, project, priority, projects, rebuildContentInOrder]);

    // Parse natural language from content (skip when updating from buttons)
    useEffect(() => {
        if (isUpdatingFromButtons) return;

        // Parse content with known projects to support multi-word project names
        const parsed = parseReminderContent(content, projects);

        // Handle priority: set if detected
        // shared parser returns 4 as default, so we check if priorityPart exists to know if it was explicitly detected
        const detectedPriority = parsed.priority;
        const hasPriorityMarker = !!parsed.priorityPart;

        if (hasPriorityMarker && detectedPriority !== priority) {
            setPriority(detectedPriority as any);
        } else if (!hasPriorityMarker && priority !== 4) {
            // Only clear if important marker was explicitly in text before
            const hadImportantMarker = /(?<=\s)!(?=\s|$)|^!(?=\s)/.test(content);
            if (!hadImportantMarker) {
                setPriority(4);
            }
        }

        // Handle project: only update if user explicitly types a #tag
        // Don't auto-reset - preserve user's choice (including the default from code block)
        const detectedProject = parsed.project;

        if (detectedProject && detectedProject !== project) {
            setProject(detectedProject);
        } else if (!detectedProject && project !== defaultProject) {
            // Reset to default when user removes the #tag from text
            setProject(defaultProject || 'Inbox');
        }

        // Handle recurrence: set if detected, but don't auto-clear
        // (user must explicitly delete the recurrence text or use the clear button)
        const detectedRecurrence = parsed.recurrence;
        if (detectedRecurrence) {
            // Only update if different from current recurrence
            const currentJson = recurrence ? JSON.stringify(recurrence) : null;
            const detectedJson = JSON.stringify(detectedRecurrence);
            if (currentJson !== detectedJson) {
                recurrenceSetFromText.current = true;
                setRecurrence(detectedRecurrence);
                // Clear dueDate when recurrence is detected (mutually exclusive)
                // Also rebuild content to remove any date text that was previously added
                if (dueDate || parsed.dueDate) {
                    setDueDate(null);
                    dueDateSetFromText.current = false;
                    // Rebuild content without the date - use cleanContent which has dates stripped
                    const cleanText = parsed.cleanContent ?? content.trim();
                    const recurrenceText = recurrenceToText(detectedRecurrence);
                    let newContent = cleanText.trim();
                    // Add recurrence text
                    newContent += ` ${recurrenceText}`;
                    // Re-add project if needed
                    if (project && project !== defaultProject && project !== 'Inbox') {
                        newContent += ` #${project}`;
                    }
                    // Re-add priority if needed
                    if (priority === 1) {
                        newContent += ' !';
                    }
                    newContent += ' ';
                    setContent(newContent);
                }
            }
        } else if (recurrence && recurrenceSetFromText.current) {
            // Recurrence was typed in content but parser no longer finds it - clear it
            setRecurrence(undefined);
            recurrenceSetFromText.current = false;
        }

        // Handle due date: set if detected
        // IMPORTANT: Don't set dueDate if recurrence was detected (they're mutually exclusive)
        // The parser returns a date for "every Wed" (next Wednesday), but we don't want that
        // when the user explicitly selected a recurrence pattern
        const detectedDueDate = parsed.dueDate;
        if (detectedDueDate && !detectedRecurrence) {
            const newDueDateStr = detectedDueDate.toISOString();
            if (dueDate !== newDueDateStr) {
                dueDateSetFromText.current = true;
                setDueDate(newDueDateStr);
            }
        } else if (!detectedDueDate && !detectedRecurrence && dueDate && (initialContentHadDate || dueDateSetFromText.current)) {
            // User removed the date text - clear if it was from initial content or typed in
            setDueDate(null);
            dueDateSetFromText.current = false;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [content, isUpdatingFromButtons, priority, project, projects, defaultProject, initialContentHadDate]);
    // Note: dueDate and recurrence intentionally excluded to prevent infinite loop

    // Handle touch on modal content to focus input (required for iOS keyboard)
    // iOS only opens keyboard on direct user gesture, so first tap in modal opens it
    const handleModalContentTouch = useCallback(() => {
        richTextInputRef.current?.focus();
    }, []);

    const handlePriorityToggle = useCallback(() => {
        const newPriority = priority === 1 ? 4 : 1;
        applyContentUpdate({ priority: newPriority }, {
            mode: 'raf',
            afterUpdate: () => {
                if (textareaRef.current) {
                    moveCursorToEnd(textareaRef.current);
                }
            }
        });
    }, [applyContentUpdate, priority, textareaRef]);

    const handleSubmit = async () => {
        if (!content.trim()) return;

        const parsed = parseReminderContent(content, projects);
        const finalContent = parsed.cleanContent?.trim() || content.trim();
        // Use detected priority only if explicitly present (priorityPart), otherwise use current state
        const finalPriority = parsed.priorityPart ? parsed.priority : priority;
        const finalProject = parsed.project || project;
        const finalDueDate = parsed.dueDate ? parsed.dueDate.toISOString() : dueDate;
        // Use detected recurrence from content or current state
        const finalRecurrence = parsed.recurrence || recurrence;

        if (!finalContent) return;

        if (optimistic) {
            // Close immediately for optimistic UI
            onClose();

            // Delay the operation to allow modal close animation (280ms) to complete
            // This ensures the new reminder animates into the list smoothly after the modal is gone
            setTimeout(async () => {
                try {
                    if (isEditing && onSave && reminder) {
                        const updatedReminder = {
                            ...reminder,
                            content: finalContent,
                            project: finalProject,
                            priority: finalPriority,
                            dueDatetime: finalDueDate || undefined,
                            dueDate: finalDueDate || undefined,
                            recurrence: finalRecurrence
                        };
                        await onSave(updatedReminder);
                    } else if (onAdd) {
                        await onAdd(finalContent, finalProject, finalPriority, finalDueDate || undefined, finalRecurrence);
                    }
                } catch (error: any) {
                    log.error(`Failed to ${isEditing ? 'update' : 'add'} reminder:`, error);
                    onError?.(error);
                }
            }, 300);
        } else {
            // Traditional behavior: wait for operation to complete
            try {
                if (isEditing && onSave && reminder) {
                    const updatedReminder = {
                        ...reminder,
                        content: finalContent,
                        project: finalProject,
                        priority: finalPriority,
                        dueDatetime: finalDueDate || undefined,
                        dueDate: finalDueDate || undefined,
                        recurrence: finalRecurrence
                    };
                    await onSave(updatedReminder);
                } else if (onAdd) {
                    await onAdd(finalContent, finalProject, finalPriority, finalDueDate || undefined, finalRecurrence);
                }
                onClose();
            } catch (error: any) {
                log.error(`Failed to ${isEditing ? 'update' : 'add'} reminder:`, error);
                onError?.(error);
            }
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleDeleteClick = () => {
        setShowDeleteConfirm(true);
    };

    const handleDeleteConfirm = async () => {
        if (!onDelete || !reminder) return;

        if (optimistic) {
            // Close immediately for optimistic UI
            setShowDeleteConfirm(false);
            onClose();

            // Handle async operation in background
            try {
                await onDelete(reminder);
            } catch (error: any) {
                log.error('Failed to delete reminder:', error);
                onError?.(error);
            }
        } else {
            // Traditional behavior: wait for operation to complete
            setIsDeleting(true);
            try {
                await onDelete(reminder);
                setShowDeleteConfirm(false);
                onClose();
            } catch (error: any) {
                log.error('Failed to delete reminder:', error);
                onError?.(error);
            } finally {
                setIsDeleting(false);
            }
        }
    };

    // Determine if any modal is showing (for shared backdrop)
    const isAnyModalOpen = showModal || currentView !== 'main';

    return (
        <>
        {/* Shared persistent backdrop - single backdrop for all modal states
            Prevents stacking issues and provides smooth transitions */}
        {showBackdrop && (
            <ModalBackdrop
                isVisible={isAnyModalOpen}
                animationConfig={animationConfig}
                zIndex={59}
            />
        )}

        {/* Main modal - BaseModal handles its own AnimatePresence internally
            Uses isOpen prop to control visibility and exit animations */}
        <BaseModal
            isOpen={showModal && (pickerMode === 'overlay' || currentView === 'main')}
            onClose={handleClose}
            onAnimationComplete={handleEntryAnimationComplete}
            animationConfig={animationConfig}
            variant={variant}
            performanceMode={variant === 'bottom-sheet' ? 'reduced-effects' : 'standard'}
            showBackdrop={false}
            disableSwipeToDismiss={currentView !== 'main'}
            style={{
                // Subtle dim effect when picker is open in overlay mode
                ...(pickerMode === 'overlay' && currentView !== 'main' ? {
                    opacity: 0.5,
                    transform: 'scale(0.98)',
                    filter: 'blur(1px)',
                } : {}),
                transition: 'opacity 220ms ease-out, transform 220ms ease-out, filter 220ms ease-out',
            }}
            contentStyle={{
                // Lift modal with keyboard (animate margin for smoother sync)
                ...(keyboardPadding > 0 ? { marginBottom: keyboardPadding } : {}),
                transition: 'margin-bottom 220ms ease-out',
            }}
        >
            <AddReminderModalHeader
                isEditing={isEditing}
                isDark={isDark}
                textColor={textColor}
                canSubmit={!!content.trim()}
                onDelete={handleDeleteClick}
                onClose={handleClose}
                onSubmit={handleSubmit}
                onTouchEnd={handleModalContentTouch}
            />
            <AddReminderModalBody
                isEditing={isEditing}
                isDark={isDark}
                textColor={textColor}
                content={content}
                onContentChange={setContent}
                onKeyDown={handleKeyDown}
                allowAutoFocus={allowAutoFocus}
                preserveSelection={!isUpdatingFromButtons}
                projects={projects}
                textareaRef={textareaRef}
                richTextInputRef={richTextInputRef}
                onTouchEnd={handleModalContentTouch}
                dueDate={dueDate}
                project={project}
                defaultProject={defaultProject}
                priority={priority}
                recurrence={recurrence}
                dueDateChanged={dueDateChanged}
                projectChanged={projectChanged}
                hasMounted={hasMounted.current}
                onOpenDatePicker={() => transitionToView('date')}
                onOpenProjectPicker={() => transitionToView('project')}
                onOpenRecurrencePicker={() => transitionToView('recurrence')}
                onTogglePriority={handlePriorityToggle}
            />
        </BaseModal>

        {/* Picker modals - BaseModal handles AnimatePresence internally */}
        <DatePickerModal
            isOpen={currentView === 'date' && !isClosing}
            onClose={closePickerModal}
            animationConfig={animationConfig}
            pickerMode={pickerMode}
            dueDate={dueDate}
            isDark={isDark}
            onDateTimeChange={(isoDate) => {
                dueDateSetFromText.current = false;
                recurrenceSetFromText.current = false;
                applyContentUpdate({ dueDate: isoDate, recurrence: null });
            }}
        />
        <ProjectPickerModal
            isOpen={currentView === 'project' && !isClosing}
            onClose={closePickerModal}
            animationConfig={animationConfig}
            pickerMode={pickerMode}
            projects={projects}
            project={project}
            defaultProject={defaultProject}
            isDark={isDark}
            onSelectProject={(selected) => {
                applyContentUpdate({ project: selected });
            }}
        />
        <RecurrencePickerModal
            isOpen={currentView === 'recurrence' && !isClosing}
            onClose={closePickerModal}
            animationConfig={animationConfig}
            pickerMode={pickerMode}
            isDark={isDark}
            recurrence={recurrence}
            onApply={(rule) => {
                if (!rule) {
                    recurrenceSetFromText.current = false;
                    applyContentUpdate({ recurrence: null });
                    return;
                }
                recurrenceSetFromText.current = false;
                dueDateSetFromText.current = false;
                applyContentUpdate({ recurrence: rule, dueDate: null });
            }}
        />

        {/* Delete Confirmation Modal - rendered outside AnimatePresence to avoid interfering with modal transitions */}
        <DeleteConfirmationModal
            isOpen={showDeleteConfirm}
            onClose={() => setShowDeleteConfirm(false)}
            onConfirm={handleDeleteConfirm}
            title="Delete Reminder"
            message={`Are you sure you want to delete "${reminder?.content?.substring(0, 50)}${(reminder?.content?.length || 0) > 50 ? '...' : ''}"? This action cannot be undone.`}
            animationConfig={animationConfig}
            isLoading={isDeleting}
        />
        </>
    );
};
