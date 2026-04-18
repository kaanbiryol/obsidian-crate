import React, { useState, useRef, useCallback } from 'react';

import type { RichTextInputHandle } from './RichTextInput';
import { BaseModal } from './BaseModal';
import { ModalBackdrop } from './ModalBackdrop';
import { AddReminderModalBody } from './addReminderModal/AddReminderModalBody';
import { AddReminderModalHeader } from './addReminderModal/AddReminderModalHeader';
import { AddReminderModalOverlays } from './addReminderModal/AddReminderModalOverlays';
import { buildDeleteConfirmationMessage } from './addReminderModal/deleteConfirmation';
import {
	buildReminderSubmission,
	executeReminderAction,
} from './addReminderModal/reminderMutation';
import { useReminderDraft } from './addReminderModal/useReminderDraft';
import { useReminderModalPresentation } from './addReminderModal/useReminderModalPresentation';
import { moveCursorToEnd } from '../utils/cursorPosition';
import { AnimationConfig } from '../ui/animations';
import { Reminder, RecurrenceRule } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('AddReminderModal');

interface AddReminderModalProps {
    onClose: () => void;
    onAdd?: (content: string, project: string, priority: number, dueDate?: string, recurrence?: RecurrenceRule, hasTime?: boolean, description?: string) => Promise<void>;
    onSave?: (reminder: Reminder) => Promise<void>;
    onDelete?: (reminder: Reminder) => Promise<void>;
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
    const textareaRef = useRef<HTMLDivElement>(null);
    const richTextInputRef = useRef<RichTextInputHandle>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const {
        content,
        setContent,
        description,
        setDescription,
        project,
        priority,
        dueDate,
        hasTime,
        recurrence,
        isUpdatingFromButtons,
        applyDateSelection,
        applyProjectSelection,
        applyRecurrenceSelection,
        togglePriority,
    } = useReminderDraft({
        reminder,
        projects,
        defaultProject,
        initialDueDate,
    });
    const {
        currentView,
        isClosing,
        showModal,
        allowAutoFocus,
        hasMounted,
        dueDateChanged,
        projectChanged,
        handleClose,
        transitionToView,
        closePickerModal,
        handleEntryAnimationComplete,
    } = useReminderModalPresentation({
        focusDelayMs,
        dueDate,
        project,
        onClose,
        richTextInputRef,
    });

    const textColor = 'var(--text-normal)';
    const keyboardPadding = keyboardOffset > 0 ? Math.max(0, keyboardOffset - 32) : 0;

    // Detect dark mode for input/dropdown styling
    const isDark = document.body.classList.contains('theme-dark');

    // Handle touch on modal content to focus input (required for iOS keyboard)
    // iOS only opens keyboard on direct user gesture, so first tap in modal opens it
    const handleModalContentTouch = useCallback(() => {
        richTextInputRef.current?.focus();
    }, []);

    const handlePriorityToggle = useCallback(() => {
        togglePriority(() => {
            if (textareaRef.current) {
                moveCursorToEnd(textareaRef.current);
            }
        });
    }, [togglePriority]);

    const handleSubmit = async () => {
        const submission = buildReminderSubmission({
            content,
            description,
            projects,
            priority,
            project,
            dueDate,
            hasTime,
            recurrence,
            reminder,
        });
        if (!submission) return;

        await executeReminderAction({
            optimistic,
            close: onClose,
            delayMs: 300,
            action: async () => {
                if (submission.updatedReminder && onSave) {
                    await onSave(submission.updatedReminder);
                } else if (onAdd) {
                    await onAdd(
                        submission.content,
                        submission.project,
                        submission.priority,
                        submission.dueDate,
                        submission.recurrence,
                        submission.hasTime,
                        submission.description,
                    );
                }
            },
            onError: (error) => {
                log.error(`Failed to ${isEditing ? 'update' : 'add'} reminder:`, error);
                onError?.(error);
            },
        });
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSubmit();
        }
    };

    const handleDeleteClick = () => {
        setShowDeleteConfirm(true);
    };

    const handleDeleteConfirm = async () => {
        if (!onDelete || !reminder) return;

        await executeReminderAction({
            optimistic,
            close: onClose,
            beforeClose: optimistic ? () => setShowDeleteConfirm(false) : undefined,
            beforeRun: optimistic ? undefined : () => setIsDeleting(true),
            afterSuccess: optimistic ? undefined : () => setShowDeleteConfirm(false),
            afterSettled: optimistic ? undefined : () => setIsDeleting(false),
            action: async () => {
                await onDelete(reminder);
            },
            onError: (error) => {
                log.error('Failed to delete reminder:', error);
                onError?.(error);
            },
        });
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
                onSubmit={() => {
                    void handleSubmit();
                }}
                onTouchEnd={handleModalContentTouch}
            />
            <AddReminderModalBody
                isEditing={isEditing}
                isDark={isDark}
                textColor={textColor}
                content={content}
                onContentChange={setContent}
                description={description}
                onDescriptionChange={setDescription}
                onKeyDown={handleKeyDown}
                allowAutoFocus={allowAutoFocus}
                preserveSelection={!isUpdatingFromButtons}
                projects={projects}
                textareaRef={textareaRef}
                richTextInputRef={richTextInputRef}
                onTouchEnd={handleModalContentTouch}
                dueDate={dueDate}
                hasTime={hasTime}
                project={project}
                defaultProject={defaultProject}
                priority={priority}
                recurrence={recurrence}
                dueDateChanged={dueDateChanged}
                projectChanged={projectChanged}
                hasMounted={hasMounted}
                onOpenDatePicker={() => transitionToView('date')}
                onOpenProjectPicker={() => transitionToView('project')}
                onOpenRecurrencePicker={() => transitionToView('recurrence')}
                onTogglePriority={handlePriorityToggle}
            />
        </BaseModal>

        <AddReminderModalOverlays
            currentView={currentView}
            isClosing={isClosing}
            animationConfig={animationConfig}
            pickerMode={pickerMode}
            dueDate={dueDate}
            hasTime={hasTime}
            isDark={isDark}
            projects={projects}
            project={project}
            defaultProject={defaultProject}
            recurrence={recurrence}
            onClosePicker={closePickerModal}
            onDateTimeChange={applyDateSelection}
            onSelectProject={applyProjectSelection}
            onApplyRecurrence={(rule) => {
                applyRecurrenceSelection(rule);
            }}
            showDeleteConfirm={showDeleteConfirm}
            onCloseDeleteConfirm={() => setShowDeleteConfirm(false)}
            onConfirmDelete={() => {
                void handleDeleteConfirm();
            }}
            deleteMessage={buildDeleteConfirmationMessage(reminder)}
            isDeleting={isDeleting}
        />
        </>
    );
};
