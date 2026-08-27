import React from 'react';
import { Button } from '@heroui/react';
import { Check, X } from 'lucide-react';
import { getProjectColor } from '@/reminders/utils/projectColors';
import {
	applyReminderTextUpdate,
} from '../reminder-state';
import type { ModalDraft } from '../types';
import { ReminderDatePicker } from './ReminderDatePicker';
import { ReminderRecurrencePicker } from './ReminderRecurrencePicker';

interface ReminderPickerSheetProps {
	draft: ModalDraft;
	dialogRef: (element: HTMLElement | null) => void;
	projectOptions: string[];
	onPatch: (patch: Partial<ModalDraft>) => void;
	onSelect: (patch?: Partial<ModalDraft>) => void;
	onClose: () => void;
}

export function ReminderPickerSheet({
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
			<section ref={dialogRef} className="pwa-picker-sheet pwa-project-picker-sheet" role="dialog" aria-modal="true" aria-label="Select project" tabIndex={-1}>
				<div className="pwa-picker-header pwa-project-picker-header">
					<h3>Project</h3>
					<Button isIconOnly className="pwa-picker-icon-button pwa-project-picker-close" type="button" aria-label="Close project selection" onClick={onClose}>
						<X size={18} />
					</Button>
				</div>
				<div className="pwa-picker-content">
					<div className="pwa-project-list ios-scroll" role="listbox" aria-label="Project selection">
						{projectOptions.map((project) => {
							const colors = getProjectColor(project);
							const selected = draft.project === project;
							return (
								<Button
									key={project}
									className={`pwa-project-option${selected ? ' is-active' : ''}`}
									type="button"
									role="option"
									aria-selected={selected}
									data-action="select-project"
									data-project={project}
									onClick={() => onSelect(applyReminderTextUpdate(draft, projectOptions, { project }))}
								>
									<span className="pwa-project-option__label">
										<span
											className="pwa-project-dot"
											style={{ '--project-color': colors.dark.accent } as React.CSSProperties}
											aria-hidden="true"
										/>
										<span className="pwa-project-option__name">{project}</span>
									</span>
									{selected ? <Check size={18} /> : null}
								</Button>
							);
						})}
					</div>
				</div>
			</section>
		);
	}

	return <ReminderRecurrencePicker draft={draft} dialogRef={dialogRef} projectOptions={projectOptions} onSelect={onSelect} onClose={onClose} />;
}
