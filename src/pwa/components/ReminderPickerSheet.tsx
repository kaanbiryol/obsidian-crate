import React, { useLayoutEffect } from 'react';
import { ProjectPickerContent } from '@/reminders/ui/reminder-modal/ProjectPickerContent';
import {
	applyReminderTextUpdate,
} from '../reminder-state';
import type { ModalDraft } from '../types';
import { ReminderDatePicker } from './ReminderDatePicker';
import { ReminderRecurrencePicker } from './ReminderRecurrencePicker';

interface ReminderPickerSheetProps {
	isDark: boolean;
	draft: ModalDraft;
	projectOptions: string[];
	onPatch: (patch: Partial<ModalDraft>) => void;
	onSelect: (patch?: Partial<ModalDraft>) => void;
	onClose: () => void;
	onReady: () => void;
}

export function ReminderPickerSheet({
	isDark,
	draft,
	projectOptions,
	onPatch,
	onSelect,
	onClose,
	onReady,
}: ReminderPickerSheetProps) {
	useLayoutEffect(onReady, [onReady]);
	if (!draft.activePicker) return null;

	if (draft.activePicker === 'date') {
		return (
			<ReminderDatePicker
				isDark={isDark}
				draft={draft}
				projectOptions={projectOptions}
				onPatch={onPatch}
				onSelect={onSelect}
				onClose={onClose}
			/>
		);
	}

	if (draft.activePicker === 'project') {
		return (
			<section className="pwa-picker-sheet pwa-project-picker-sheet" tabIndex={-1}>
                <ProjectPickerContent
                    isOpen projects={projectOptions} project={draft.project} defaultProject={draft.defaultProject}
                    isDark={isDark} onClose={onClose}
                    onSelectProject={(project) => onSelect(applyReminderTextUpdate(draft, projectOptions, { project }))}
                />
			</section>
		);
	}

	return <ReminderRecurrencePicker isDark={isDark} draft={draft} projectOptions={projectOptions} onSelect={onSelect} onClose={onClose} />;
}
