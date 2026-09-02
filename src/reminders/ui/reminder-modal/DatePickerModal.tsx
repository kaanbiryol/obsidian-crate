import React, { useCallback } from 'react';

import { BaseModal } from '../../components/BaseModal';
import type { AnimationConfig } from '../animations';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { getPickerModalProps } from '../glassStyles';
import { DateQuickButtons } from './DateQuickButtons';
import { PickerHeader } from './PickerHeader';
import { PickerTimeCard } from './PickerTimeCard';
import { PickerDoneButton } from './PickerDoneButton';
import { formatLocalDateKey, parseLocalDateKey, parseReminderDateValue } from '../../utils/reminderDate';
import { buildDatePickerDateSelection, buildDatePickerTimeSelection } from './datePickerSelection';
import { getReminderDateForPreset, type ReminderDatePreset } from './datePresets';
import { REMINDER_PICKER_COPY } from './pickerCopy';
import { formatDueDate } from '../../utils/dateFormatting';

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
        onClose();
    }, [onClose, onDateTimeChange]);

    return (
        <BaseModal
            isOpen={isOpen}
            onClose={onClose}
            animationConfig={animationConfig}
            className={`crate-reminder-picker-surface is-date-picker${reduceMotion ? ' is-reduced-motion' : ''}`}
            ariaLabel={REMINDER_PICKER_COPY.schedule.dialogLabel}
            {...modalProps}
        >
            <div className={`reminder-picker reminder-date-picker${isDark ? ' dark' : ''}`}>
                <PickerHeader
                    onBack={onClose}
                    closeLabel={REMINDER_PICKER_COPY.schedule.closeLabel}
                    title={REMINDER_PICKER_COPY.schedule.title}
                    actionLabel={REMINDER_PICKER_COPY.schedule.done}
                    onAction={onClose}
                />

                <div className="reminder-picker-scroll">
                    {currentDate && (
                        <div className="picker-current-summary" aria-live="polite">
                            <span>{REMINDER_PICKER_COPY.schedule.current}</span>
                            <strong>{formatDueDate(dueDate ?? undefined)}</strong>
                        </div>
                    )}

                    <section className="picker-section" aria-labelledby="plugin-quick-schedule-title">
                        <div className="picker-section-heading">
                            <h4 id="plugin-quick-schedule-title">{REMINDER_PICKER_COPY.schedule.quickOptions}</h4>
                        </div>
                        <DateQuickButtons
                            currentDate={currentDate}
                            hasTime={hasTime ?? false}
                            onSelectPreset={handleQuickDate}
                        />
                    </section>

                    <section className="picker-section" aria-labelledby="plugin-custom-schedule-title">
                        <div className="picker-section-heading">
                            <h4 id="plugin-custom-schedule-title">{REMINDER_PICKER_COPY.schedule.custom}</h4>
                        </div>
                        <div className="picker-schedule-fields">
                            <label className="picker-date-field">
                                <span className="picker-field-copy">
                                    <strong>{REMINDER_PICKER_COPY.schedule.date}</strong>
                                </span>
                                <input
                                    type="date"
                                    aria-label={REMINDER_PICKER_COPY.schedule.date}
                                    value={currentDate ? formatLocalDateKey(currentDate) : ''}
                                    onChange={(event) => handleDateChange(event.currentTarget.value)}
                                    className="picker-date-input"
                                />
                            </label>
                            <PickerTimeCard
                                label={REMINDER_PICKER_COPY.schedule.time}
                                optionalLabel={REMINDER_PICKER_COPY.schedule.optional}
                                hour={currentDate && hasTime ? currentDate.getHours() : undefined}
                                minute={currentDate && hasTime ? currentDate.getMinutes() : undefined}
                                onChange={handleTimeChange}
                                onClear={handleTimeClear}
                            />
                        </div>
                    </section>

                    <PickerDoneButton
                        showPrimary={false}
                        removeAction={currentDate ? {
                            label: REMINDER_PICKER_COPY.schedule.remove,
                            onClick: handleRemoveSchedule,
                        } : undefined}
                    />
                </div>
            </div>
        </BaseModal>
    );
};
