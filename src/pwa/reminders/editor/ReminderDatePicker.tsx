import { DatePickerContent } from '@/reminders/ui/reminder-editor/DatePickerContent';
import { formatLocalDateKey, parseReminderDateValue } from '@/reminders/core/dates/reminderDate';
import { applyDateFieldsToDraft, applyDatePresetToDraft } from './editor-draft';
import type { ModalDraft } from '../types';

export function ReminderDatePicker({ draft, projectOptions, isDark, onPatch, onSelect, onClose }: {
	draft: ModalDraft;
	projectOptions: string[];
	isDark: boolean;
	onPatch: (patch: Partial<ModalDraft>) => void;
	onSelect: (patch?: Partial<ModalDraft>) => void;
	onClose: () => void;
}) {
	// A repeat's occurrence is not a chosen date.
	const dueDate = draft.recurrence ? '' : draft.dueDate;
	const dueTime = draft.recurrence ? '' : draft.dueTime;
	const currentDate = dueDate
		? parseReminderDateValue(dueTime ? `${dueDate}T${dueTime}` : dueDate, Boolean(dueTime)) ?? null
		: null;
	return (
		<section className="pwa-picker-sheet pwa-date-picker-sheet" tabIndex={-1}>
			<DatePickerContent
				currentDate={currentDate} hasTime={Boolean(dueTime)} isDark={isDark}
				idPrefix="pwa" commitDateOnChange onClose={onClose}
				onSelectPreset={(preset) => onSelect(applyDatePresetToDraft(draft, projectOptions, preset))}
				onDateChange={(value) => onPatch(applyDateFieldsToDraft(draft, projectOptions, value, dueTime))}
				onTimeChange={(hour, minute) => onPatch(applyDateFieldsToDraft(
					draft, projectOptions, dueDate || formatLocalDateKey(new Date()),
					`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
				))}
				onTimeClear={() => onPatch(applyDateFieldsToDraft(draft, projectOptions, dueDate, ''))}
				onRemove={() => onPatch(applyDatePresetToDraft(draft, projectOptions, 'clear'))}
			/>
		</section>
	);
}
