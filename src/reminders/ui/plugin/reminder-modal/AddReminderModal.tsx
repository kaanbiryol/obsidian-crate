import React, { useRef, useCallback, useMemo } from 'react';

import type { RichTextInputHandle } from '../../shared/RichTextInput';
import { BaseModal } from '../../../../ui/shared/BaseModal';
import { AddReminderModalBody } from './AddReminderModalBody';
import { AddReminderModalHeader } from './AddReminderModalHeader';
import { AddReminderModalOverlays } from './AddReminderModalOverlays';
import { useReminderModalActions } from './useReminderModalActions';
import type { NewReminder } from './reminderMutation';
import { useReminderDraft } from './useReminderDraft';
import { useReminderModalPresentation } from './useReminderModalPresentation';
import { useObsidianDarkMode } from '../hooks/useObsidianDarkMode';
import { AnimationConfig } from '../../../../ui/shared/component-adapter';
import { useReducedMotion } from '../../../../ui/shared/useReducedMotion';
import { Reminder } from '../../../types';
import { DEFAULT_PROJECT } from '../../../core/constants';
import { parseReminderContent } from '../../../core/grammar/reminderParser';
import { getReminderTitleCaret } from '../../reminder-editor/reminderEditorEdits';
import { saveCursorPosition } from '../../../../ui/shared/cursorPosition';

interface AddReminderModalProps {
	onClose: () => void;
	onAdd?: (reminder: NewReminder) => Promise<void>;
	onSave?: (reminder: Reminder) => Promise<void>;
	onDelete?: (reminder: Reminder) => Promise<void>;
	onError?: (error: Error) => void;
	reminder?: Reminder;
	projects?: string[];
	defaultProject?: string;
	initialDueDate?: string;
	animationConfig?: AnimationConfig;
	/**
	 * 'bottom-sheet' (default, mobile) dims the backdrop and replaces the editor while a picker
	 * (date, project, recurrence) is open. 'centered' (desktop) opens pickers over the editor.
	 */
	variant?: 'bottom-sheet' | 'centered';
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
	defaultProject = DEFAULT_PROJECT,
	initialDueDate,
	animationConfig = { enabled: true },
	variant = 'bottom-sheet',
	keyboardOffset = 0,
}) => {
	const pickerMode = variant === 'centered' ? 'overlay' : 'replace';
	const isEditing = !!reminder;
	const focusDelayMs = 0;
	const textareaRef = useRef<HTMLDivElement>(null);
	const richTextInputRef = useRef<RichTextInputHandle>(null);
	const descriptionInputRef = useRef<RichTextInputHandle>(null);
	const draft = useReminderDraft({
		reminder,
		projects,
		defaultProject,
		initialDueDate,
	});
	const { content, description, project, priority, dueDate, hasTime, recurrence, togglePriority } = draft;
	const hasTitle = useMemo(
		() => Boolean(parseReminderContent(content, projects).cleanContent.trim()),
		[content, projects],
	);
	const {
		currentView,
		isClosing,
		showModal,
		allowAutoFocus,
		handleClose: closePresentation,
		handleModalExitComplete,
		transitionToView,
		closePickerModal,
		handleEntryAnimationComplete,
	} = useReminderModalPresentation({
		focusDelayMs,
		onClose,
		richTextInputRef,
		projects,
	});
	const {
		showDeleteConfirm,
		isDeleting,
		isSaving,
		isPending,
		deleteMessage,
		handleSubmit,
		handleDeleteClick,
		handleDeleteConfirm,
		closeDeleteConfirm,
	} = useReminderModalActions({
		readEditor: () => ({
			content: richTextInputRef.current?.getValue() ?? content,
			description: descriptionInputRef.current?.getValue() ?? description,
		}),
		projects,
		priority,
		project,
		dueDate,
		hasTime,
		recurrence,
		reminder,
		onClose: closePresentation,
		onAdd,
		onSave,
		onDelete,
		onError,
	});

	const handleClose = () => { if (!isPending()) closePresentation(); };

	// Keep project accents and picker chrome in sync when the active theme changes.
	const isDark = useObsidianDarkMode();
	const reduceMotion = useReducedMotion();
	const animationsEnabled = animationConfig.enabled && !reduceMotion;

	const handlePriorityToggle = useCallback(() => {
		const caret = saveCursorPosition(richTextInputRef.current?.getElement() ?? null);
		const nextContent = togglePriority();
		const wordsEnd = getReminderTitleCaret(nextContent, projects);
		richTextInputRef.current?.setCursorPosition(Math.min(caret ?? wordsEnd, wordsEnd), {
			scrollTop: textareaRef.current?.scrollTop ?? 0,
		});
	}, [projects, togglePriority]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void handleSubmit();
		}
	};

	return (
		<BaseModal
			isOpen={showModal && (pickerMode === 'overlay' || currentView === 'main')}
			onClose={handleClose}
			onAnimationComplete={handleEntryAnimationComplete}
			onExitComplete={handleModalExitComplete}
			animationConfig={animationConfig}
			variant={variant}
			className={`crate-reminder-editor-surface${reduceMotion ? ' is-reduced-motion' : ''}`}
			ariaLabel={isEditing ? 'Edit reminder' : 'New reminder'}
			showBackdrop={variant === 'bottom-sheet'}
			dismissible={!isSaving && !isDeleting && !showDeleteConfirm && currentView === 'main'}
			disableSwipeToDismiss={isSaving || isDeleting || currentView !== 'main'}
			style={{
				// Subtle dim effect when picker is open in overlay mode
				...(pickerMode === 'overlay' && currentView !== 'main' ? {
					opacity: 0.5,
					transform: 'scale(0.98)',
					filter: 'blur(var(--blur-s, 1px))',
					pointerEvents: 'none',
				} : {}),
				transition: animationsEnabled
					? 'opacity var(--crate-motion-duration-moderate) var(--crate-motion-easing), transform var(--crate-motion-duration-moderate) var(--crate-motion-easing), filter var(--crate-motion-duration-moderate) var(--crate-motion-easing)'
					: 'none',
			}}
			contentStyle={{
				// Keep the whole editor above the on-screen keyboard and below the status bar.
				...(keyboardOffset > 0 ? {
					marginBottom: keyboardOffset,
					maxHeight: `calc(100dvh - ${keyboardOffset}px - var(--safe-area-inset-top, env(safe-area-inset-top)) - 20px)`,
					minHeight: 0,
					paddingBottom: 18,
				} : {}),
			}}
			overlays={
				<AddReminderModalOverlays
					currentView={currentView}
					isClosing={isClosing}
					animationConfig={animationConfig}
					pickerMode={pickerMode}
					draft={draft}
					isDark={isDark}
					projects={projects}
					defaultProject={defaultProject}
					onClosePicker={closePickerModal}
					editorFocus={() => richTextInputRef.current?.getElement() ?? false}
					showDeleteConfirm={showDeleteConfirm}
					onCloseDeleteConfirm={closeDeleteConfirm}
					onConfirmDelete={() => {
						void handleDeleteConfirm();
					}}
					deleteMessage={deleteMessage}
					isDeleting={isDeleting}
				/>
			}
		>
			<AddReminderModalHeader
				isEditing={isEditing}
				canSubmit={hasTitle && !isSaving && !isDeleting}
				busy={isSaving || isDeleting}
				onDelete={handleDeleteClick}
				onClose={handleClose}
				onSubmit={() => {
					void handleSubmit();
				}}
			/>
			<div inert={isSaving || isDeleting}>
				<AddReminderModalBody
					isDark={isDark}
					draft={draft}
					onKeyDown={handleKeyDown}
					allowAutoFocus={allowAutoFocus}
					projects={projects}
					textareaRef={textareaRef}
					richTextInputRef={richTextInputRef}
					descriptionInputRef={descriptionInputRef}
					defaultProject={defaultProject}
					onOpenDatePicker={() => transitionToView('date')}
					onOpenProjectPicker={() => transitionToView('project')}
					onOpenRecurrencePicker={() => transitionToView('recurrence')}
					onTogglePriority={handlePriorityToggle}
				/>
			</div>
		</BaseModal>
	);
};
