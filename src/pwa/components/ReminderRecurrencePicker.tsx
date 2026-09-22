import { useEffect, useMemo, useState } from 'react';
import { useObsidianReducedMotion } from '@/reminders/ui/useObsidianReducedMotion';
import { RecurrencePickerContent } from '@/reminders/ui/reminder-modal/RecurrencePickerContent';
import { buildRecurrencePickerDraft, buildRecurrencePickerState, isRecurrencePickerStateUnchanged, recurrenceRuleFromPickerDraft } from '@/reminders/ui/reminder-modal/recurrencePickerShared';
import { applyReminderTextUpdate } from '../reminder-state';
import type { ModalDraft } from '../types';

export function ReminderRecurrencePicker({ draft, projectOptions, isDark, onSelect, onClose }: {
    draft: ModalDraft;
    projectOptions: string[];
    isDark: boolean;
    onSelect: (patch?: Partial<ModalDraft>) => void;
    onClose: () => void;
}) {
    const reduceMotion = useObsidianReducedMotion();
    const initialState = useMemo(() => buildRecurrencePickerState(draft.recurrence), [draft.recurrence]);
    const [recurrenceDraft, setRecurrenceDraft] = useState(() => buildRecurrencePickerDraft(draft.recurrence));
    useEffect(() => setRecurrenceDraft(buildRecurrencePickerDraft(draft.recurrence)), [draft.recurrence]);
    const liveRule = recurrenceRuleFromPickerDraft(recurrenceDraft, draft.recurrence?.timezone);
    const state = { ...recurrenceDraft, hour: liveRule.hour ?? 9, minute: liveRule.minute ?? 0 };
    return (
        <section className="pwa-picker-sheet pwa-repeat-picker-sheet" tabIndex={-1}>
            <RecurrencePickerContent
                isDark={isDark} animationsEnabled={!reduceMotion} canRemove={Boolean(draft.recurrence)}
                state={state}
                onChange={(patch) => setRecurrenceDraft((current) => ({
                    ...current,
                    ...patch,
                    ...(patch.hour !== undefined || patch.minute !== undefined ? { second: undefined, millisecond: undefined } : {}),
                    time: patch.hour !== undefined && patch.minute !== undefined
                        ? `${String(patch.hour).padStart(2, '0')}:${String(patch.minute).padStart(2, '0')}`
                        : current.time,
                }))}
                onClose={onClose}
                onDone={() => {
                    if (draft.recurrence && isRecurrencePickerStateUnchanged(state, initialState)) {
                        onClose();
                        return;
                    }
                    onSelect(applyReminderTextUpdate(draft, projectOptions, {
                        recurrence: liveRule, dueDateValue: null, hasTime: false,
                    }));
                }}
                onRemove={() => onSelect(applyReminderTextUpdate(draft, projectOptions, {
                    recurrence: null, dueDateValue: null, hasTime: false,
                }))}
            />
        </section>
    );
}
