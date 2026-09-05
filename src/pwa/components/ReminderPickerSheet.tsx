import React from 'react';
import { ProjectPickerContent } from '@/reminders/ui/reminder-modal/ProjectPickerContent';
import { REMINDER_PICKER_COPY } from '@/reminders/ui/reminder-modal/pickerCopy';
import {
	applyReminderTextUpdate,
} from '../reminder-state';
import type { ModalDraft } from '../types';
import { ReminderDatePicker } from './ReminderDatePicker';
import { ReminderRecurrencePicker } from './ReminderRecurrencePicker';

interface ReminderPickerSheetProps {
	isDark: boolean;
	draft: ModalDraft;
	dialogRef: (element: HTMLElement | null) => void;
	projectOptions: string[];
	onPatch: (patch: Partial<ModalDraft>) => void;
	onSelect: (patch?: Partial<ModalDraft>) => void;
	onClose: () => void;
}

export function ReminderPickerSheet({
	isDark,
	draft,
	dialogRef,
	projectOptions,
	onPatch,
	onSelect,
	onClose,
}: ReminderPickerSheetProps) {
	if (!draft.activePicker) return null;

	if (draft.activePicker === 'date') {
		return (
			<ReminderDatePicker
				isDark={isDark}
				draft={draft}
				dialogRef={dialogRef}
				projectOptions={projectOptions}
				onPatch={onPatch}
				onSelect={onSelect}
				onClose={onClose}
			/>
		);
	}

	if (draft.activePicker === 'project') {
		return (
			<section ref={dialogRef} className="pwa-picker-sheet pwa-project-picker-sheet" role="dialog" aria-modal="true" aria-label={REMINDER_PICKER_COPY.project.dialogLabel} tabIndex={-1}>
                <ProjectPickerContent
                    isOpen projects={projectOptions} project={draft.project} defaultProject={draft.defaultProject}
                    isDark={isDark} onClose={onClose}
                    onSelectProject={(project) => onSelect(applyReminderTextUpdate(draft, projectOptions, { project }))}
                />
			</section>
		);
	}

	return <ReminderRecurrencePicker isDark={isDark} draft={draft} dialogRef={dialogRef} projectOptions={projectOptions} onSelect={onSelect} onClose={onClose} />;
}
