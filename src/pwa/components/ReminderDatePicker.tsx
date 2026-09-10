import { DatePickerContent } from '@/reminders/ui/reminder-modal/DatePickerContent';
import { REMINDER_PICKER_COPY } from '@/reminders/ui/reminder-modal/pickerCopy';
import { formatLocalDateKey, parseReminderDateValue } from '@/reminders/utils/reminderDate';
import { applyDateFieldsToDraft, applyDatePresetToDraft } from '../reminder-state';
import type { ModalDraft } from '../types';

export function ReminderDatePicker({ draft, dialogRef, projectOptions, isDark, onPatch, onSelect, onClose }: {
    draft: ModalDraft;
    dialogRef: (element: HTMLElement | null) => void;
    projectOptions: string[];
    isDark: boolean;
    onPatch: (patch: Partial<ModalDraft>) => void;
    onSelect: (patch?: Partial<ModalDraft>) => void;
    onClose: () => void;
}) {
    const currentDate = draft.dueDate
        ? parseReminderDateValue(draft.dueTime ? `${draft.dueDate}T${draft.dueTime}` : draft.dueDate, Boolean(draft.dueTime)) ?? null
        : null;
    return (
        <section ref={dialogRef} className="pwa-picker-sheet pwa-date-picker-sheet" role="dialog" aria-modal="true" aria-label={REMINDER_PICKER_COPY.schedule.dialogLabel} tabIndex={-1}>
            <DatePickerContent
                currentDate={currentDate} hasTime={Boolean(draft.dueTime)} isDark={isDark}
                idPrefix="pwa" commitDateOnChange onClose={onClose}
                onSelectPreset={(preset) => onSelect(applyDatePresetToDraft(draft, projectOptions, preset))}
                onDateChange={(value) => onPatch(applyDateFieldsToDraft(draft, projectOptions, value, draft.dueTime))}
                onTimeChange={(hour, minute) => onPatch(applyDateFieldsToDraft(
                    draft, projectOptions, draft.dueDate || formatLocalDateKey(new Date()),
                    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
                ))}
                onTimeClear={() => onPatch(applyDateFieldsToDraft(draft, projectOptions, draft.dueDate, ''))}
                onRemove={() => onPatch(applyDatePresetToDraft(draft, projectOptions, 'clear'))}
            />
        </section>
    );
}
