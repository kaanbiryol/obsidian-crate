import React, { useState, useCallback } from 'react';
import { parseDate, today, getLocalTimeZone, CalendarDate } from '@internationalized/date';

import { BaseModal } from '../../components/BaseModal';
import { AnimationConfig, prefersReducedMotion } from '../animations';
import { getPickerModalProps } from '../glassStyles';
import { DateCalendarPanel } from './DateCalendarPanel';
import { DateQuickButtons } from './DateQuickButtons';
import { PickerHeader } from './PickerHeader';
import { PickerTimeCard } from './PickerTimeCard';
import { PickerDoneButton } from './PickerDoneButton';
import { formatLocalDateKey, parseReminderDateValue } from '../../utils/reminderDate';
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
    const animationsEnabled = animationConfig.enabled && !prefersReducedMotion();
    const currentDate = parseReminderDateValue(dueDate, hasTime) ?? null;
    const modalProps = getPickerModalProps(pickerMode);

    const [calendarDirection, setCalendarDirection] = useState(0);
    const [displayMonth, setDisplayMonth] = useState<CalendarDate>(() =>
        currentDate ? parseDate(formatLocalDateKey(currentDate)) : today(getLocalTimeZone())
    );

    const handlePrevMonth = useCallback(() => {
        setCalendarDirection(-1);
        setDisplayMonth(prev => prev.subtract({ months: 1 }));
    }, []);

    const handleNextMonth = useCallback(() => {
        setCalendarDirection(1);
        setDisplayMonth(prev => prev.add({ months: 1 }));
    }, []);

    const handleQuickDate = useCallback((preset: ReminderDatePreset) => {
        const date = getReminderDateForPreset(preset);
        const presetHasTime = preset === 'evening';
        const selection = buildDatePickerDateSelection(
            date,
            date,
            presetHasTime,
        );
        onDateTimeChange(selection.value, selection.hasTime);
        setDisplayMonth(parseDate(formatLocalDateKey(date)));
    }, [onDateTimeChange]);

    const handleCalendarDateChange = useCallback((date: CalendarDate) => {
        const selection = buildDatePickerDateSelection(
            new Date(date.year, date.month - 1, date.day),
            parseReminderDateValue(dueDate, hasTime) ?? null,
            hasTime ?? false,
        );
        onDateTimeChange(selection.value, selection.hasTime);
        setDisplayMonth(date);
    }, [dueDate, hasTime, onDateTimeChange]);

    const handleTimeChange = useCallback((hour: number, minute: number) => {
        const selection = buildDatePickerTimeSelection(
            hour,
            minute,
            parseReminderDateValue(dueDate, hasTime) ?? null,
        );
        onDateTimeChange(selection.value, selection.hasTime);
    }, [dueDate, hasTime, onDateTimeChange]);

    const handleRemoveSchedule = useCallback(() => {
        onDateTimeChange(null, false);
        onClose();
    }, [onClose, onDateTimeChange]);

    return (
        <BaseModal
            isOpen={isOpen}
            onClose={onClose}
            animationConfig={animationConfig}
            className="crate-reminder-picker-surface is-date-picker"
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
                        <div className="picker-field-label">
                            <strong>{REMINDER_PICKER_COPY.schedule.date}</strong>
                        </div>
                        <DateCalendarPanel
                            currentDate={currentDate}
                            displayMonth={displayMonth}
                            calendarDirection={calendarDirection}
                            animationsEnabled={animationsEnabled}
                            onPrevMonth={handlePrevMonth}
                            onNextMonth={handleNextMonth}
                            onDateChange={handleCalendarDateChange}
                        />

                        <div className="picker-time-section-card">
                            <PickerTimeCard
                                label={REMINDER_PICKER_COPY.schedule.time}
                                optionalLabel={REMINDER_PICKER_COPY.schedule.optional}
                                hour={currentDate ? (hasTime ? currentDate.getHours() : 9) : 9}
                                minute={currentDate ? (hasTime ? currentDate.getMinutes() : 0) : 0}
                                onChange={handleTimeChange}
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
