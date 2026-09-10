import { useEffect, useState } from 'react';
import { useObsidianReducedMotion } from '@/reminders/ui/useObsidianReducedMotion';
import { RecurrencePickerContent } from '@/reminders/ui/reminder-modal/RecurrencePickerContent';
import { buildRecurrencePickerDraft, recurrenceRuleFromPickerDraft } from '@/reminders/ui/reminder-modal/recurrencePickerShared';
import { REMINDER_PICKER_COPY } from '@/reminders/ui/reminder-modal/pickerCopy';
import { applyReminderTextUpdate } from '../reminder-state';
import type { ModalDraft } from '../types';

export function ReminderRecurrencePicker({ draft, dialogRef, projectOptions, isDark, onSelect, onClose }: {
    draft: ModalDraft;
    dialogRef: (element: HTMLElement | null) => void;
    projectOptions: string[];
    isDark: boolean;
    onSelect: (patch?: Partial<ModalDraft>) => void;
    onClose: () => void;
}) {
    const reduceMotion = useObsidianReducedMotion();
    const [recurrenceDraft, setRecurrenceDraft] = useState(() => buildRecurrencePickerDraft(draft.recurrence));
    useEffect(() => setRecurrenceDraft(buildRecurrencePickerDraft(draft.recurrence)), [draft.recurrence]);
    const liveRule = recurrenceRuleFromPickerDraft(recurrenceDraft);
    return (
        <section ref={dialogRef} className="pwa-picker-sheet pwa-repeat-picker-sheet" role="dialog" aria-modal="true" aria-label={REMINDER_PICKER_COPY.repeat.dialogLabel} tabIndex={-1}>
            <RecurrencePickerContent
                isDark={isDark} animationsEnabled={!reduceMotion} canRemove={Boolean(draft.recurrence)}
                state={{ ...recurrenceDraft, hour: liveRule.hour ?? 9, minute: liveRule.minute ?? 0 }}
                onChange={(patch) => setRecurrenceDraft((current) => ({
                    ...current,
                    ...patch,
                    time: patch.hour !== undefined && patch.minute !== undefined
                        ? `${String(patch.hour).padStart(2, '0')}:${String(patch.minute).padStart(2, '0')}`
                        : current.time,
                }))}
                onClose={onClose}
                onDone={() => onSelect(applyReminderTextUpdate(draft, projectOptions, {
                    recurrence: liveRule, dueDateValue: null, hasTime: false,
                }))}
                onRemove={() => onSelect(applyReminderTextUpdate(draft, projectOptions, {
                    recurrence: null, dueDateValue: null, hasTime: false,
                }))}
            />
        </section>
    );
}
