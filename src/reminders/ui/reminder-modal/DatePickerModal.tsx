import { DatePickerContent } from './DatePickerContent';
import { ThemeIconProvider } from '../../components/theme-icon';
import { ObsidianIcon } from '../../components/obsidian-icon';
import React, { useCallback } from 'react';

import { BaseModal } from '../../components/BaseModal';
import type { AnimationConfig } from '../animations';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { getPickerModalProps } from '../glassStyles';
import { parseLocalDateKey, parseReminderDateValue } from '../../utils/reminderDate';
import { buildDatePickerDateSelection, buildDatePickerTimeSelection } from './datePickerSelection';
import { getReminderDateForPreset, type ReminderDatePreset } from './datePresets';
import { REMINDER_PICKER_COPY } from './pickerCopy';

interface DatePickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    animationConfig: AnimationConfig;
    pickerMode: 'replace' | 'overlay';
    dueDate: string | null;
    hasTime?: boolean;
    isDark: boolean;
    onDateTimeChange: (value: string | null, hasTime: boolean) => void;
}

export const DatePickerModal: React.FC<DatePickerModalProps> = ({
    isOpen,
    onClose,
    animationConfig,
    pickerMode,
    dueDate,
    hasTime,
    isDark,
    onDateTimeChange,
}) => {
    const reduceMotion = useObsidianReducedMotion();
    const currentDate = parseReminderDateValue(dueDate, hasTime) ?? null;
    const modalProps = getPickerModalProps(pickerMode);

    const handleQuickDate = useCallback((preset: ReminderDatePreset) => {
        const date = getReminderDateForPreset(preset);
        const presetHasTime = preset === 'evening';
        const selection = buildDatePickerDateSelection(
            date,
            date,
            presetHasTime,
        );
        onDateTimeChange(selection.value, selection.hasTime);
    }, [onDateTimeChange]);

    const handleDateChange = useCallback((value: string) => {
        if (!value) {
            onDateTimeChange(null, false);
            return;
        }

        const selection = buildDatePickerDateSelection(
            parseLocalDateKey(value),
            parseReminderDateValue(dueDate, hasTime) ?? null,
            hasTime ?? false,
        );
        onDateTimeChange(selection.value, selection.hasTime);
    }, [dueDate, hasTime, onDateTimeChange]);

    const handleTimeChange = useCallback((hour: number, minute: number) => {
        const selection = buildDatePickerTimeSelection(
            hour,
            minute,
            parseReminderDateValue(dueDate, hasTime) ?? null,
        );
        onDateTimeChange(selection.value, selection.hasTime);
    }, [dueDate, hasTime, onDateTimeChange]);

    const handleTimeClear = useCallback(() => {
        if (!currentDate) {
            onDateTimeChange(null, false);
            return;
        }

        const selection = buildDatePickerDateSelection(currentDate, currentDate, false);
        onDateTimeChange(selection.value, selection.hasTime);
    }, [currentDate, onDateTimeChange]);

    const handleRemoveSchedule = useCallback(() => {
        onDateTimeChange(null, false);
    }, [onDateTimeChange]);

    return (
        <BaseModal
            isOpen={isOpen}
            onClose={onClose}
            animationConfig={animationConfig}
            className={`crate-reminder-picker-surface is-date-picker${reduceMotion ? ' is-reduced-motion' : ''}`}
            ariaLabel={REMINDER_PICKER_COPY.schedule.dialogLabel}
            {...modalProps}
        >
            <ThemeIconProvider renderer={ObsidianIcon}>
                <DatePickerContent
                    currentDate={currentDate} hasTime={hasTime ?? false} isDark={isDark}
                    onClose={onClose} onSelectPreset={handleQuickDate} onDateChange={handleDateChange}
                    onTimeChange={handleTimeChange} onTimeClear={handleTimeClear} onRemove={handleRemoveSchedule}
                />
            </ThemeIconProvider>
        </BaseModal>
    );
};
