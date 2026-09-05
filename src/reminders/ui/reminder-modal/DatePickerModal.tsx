import React, { useCallback } from 'react';

import { BaseModal } from '../../components/BaseModal';
import { ModalHeader } from '../../components/ModalHeader';
import type { AnimationConfig } from '../animations';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { getPickerModalProps } from '../glassStyles';
import { DateQuickButtons } from './DateQuickButtons';
import { EditableDateControl } from './EditableDateControl';
import { PickerTimeCard } from './PickerTimeCard';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { PickerContent } from './PickerContent';
import { PickerFieldRow } from './PickerFieldRow';
import { PickerSection } from './PickerSection';
import { formatLocalDateKey, parseLocalDateKey, parseReminderDateValue } from '../../utils/reminderDate';
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
                        <PickerSection
                            headingId="plugin-quick-schedule-title"
                            title={REMINDER_PICKER_COPY.schedule.quickOptions}
                        >
                            <DateQuickButtons
                                currentDate={currentDate}
                                hasTime={hasTime ?? false}
                                onSelectPreset={handleQuickDate}
                            />
                        </PickerSection>

                        <PickerSection
                            headingId="plugin-custom-schedule-title"
                            title={REMINDER_PICKER_COPY.schedule.custom}
                            className="picker-custom-schedule"
                            action={currentDate ? (
                                <ShadowDOMNativeButton
                                    className="picker-schedule-remove"
                                    onClick={handleRemoveSchedule}
                                >
                                    {REMINDER_PICKER_COPY.schedule.remove}
                                </ShadowDOMNativeButton>
                            ) : undefined}
                        >
                            <div className="picker-schedule-fields">
                                <PickerFieldRow
                                    label={REMINDER_PICKER_COPY.schedule.date}
                                    className="picker-date-field"
                                    asLabel
                                >
                                    <EditableDateControl
                                        label={REMINDER_PICKER_COPY.schedule.date}
                                        emptyLabel={REMINDER_PICKER_COPY.schedule.addDate}
                                        invalidMessage={REMINDER_PICKER_COPY.schedule.invalidDate}
                                        value={currentDate ? formatLocalDateKey(currentDate) : ''}
                                        onChange={handleDateChange}
                                    />
                                </PickerFieldRow>
                                <PickerTimeCard
                                    label={REMINDER_PICKER_COPY.schedule.time}
                                    controlIcon="clock"
                                    controlEmptyLabel={REMINDER_PICKER_COPY.schedule.addTime}
                                    hour={currentDate && hasTime ? currentDate.getHours() : undefined}
                                    minute={currentDate && hasTime ? currentDate.getMinutes() : undefined}
                                    onChange={handleTimeChange}
                                    onClear={handleTimeClear}
                                />
                            </div>
                        </PickerSection>
                    </PickerContent>
                </div>
            </div>
        </BaseModal>
    );
};
