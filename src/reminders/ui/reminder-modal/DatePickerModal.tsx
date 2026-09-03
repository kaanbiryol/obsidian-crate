import React, { useCallback } from 'react';

import { BaseModal } from '../../components/BaseModal';
import { ModalHeader } from '../../components/ModalHeader';
import type { AnimationConfig } from '../animations';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { getPickerModalProps } from '../glassStyles';
import { DateQuickButtons } from './DateQuickButtons';
import { PickerTimeCard } from './PickerTimeCard';
import { PickerDoneButton } from './PickerDoneButton';
import { PickerContent } from './PickerContent';
import { PickerCurrentSummary } from './PickerCurrentSummary';
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
                <ModalHeader
                    onClose={onClose}
                    closeLabel={REMINDER_PICKER_COPY.schedule.closeLabel}
                    title={REMINDER_PICKER_COPY.schedule.title}
                    action={{
                        label: REMINDER_PICKER_COPY.schedule.done,
                        onClick: onClose,
                    }}
                />

                <div className="reminder-picker-scroll">
                    <PickerContent>
                        {currentDate && (
                            <PickerCurrentSummary
                                label={REMINDER_PICKER_COPY.schedule.current}
                                value={formatDueDate(dueDate ?? undefined) ?? ''}
                                icon="calendar"
                            />
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
                                <label className="picker-control-row picker-date-field">
                                    <span className="picker-field-copy">
                                        <strong>{REMINDER_PICKER_COPY.schedule.date}</strong>
                                    </span>
                                    <input
                                        type="date"
                                        aria-label={REMINDER_PICKER_COPY.schedule.date}
                                        value={currentDate ? formatLocalDateKey(currentDate) : ''}
                                        onChange={(event) => handleDateChange(event.currentTarget.value)}
                                        className={`picker-date-input${currentDate ? ' has-value' : ''}`}
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
                    </PickerContent>

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
