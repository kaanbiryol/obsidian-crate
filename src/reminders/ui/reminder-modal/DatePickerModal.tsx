import React, { useState, useMemo, useCallback } from 'react';
import { parseDate, today, getLocalTimeZone, CalendarDate } from '@internationalized/date';
import { format, addDays, isSameDay } from 'date-fns';

import { BaseModal } from '../../components/BaseModal';
import { AnimationConfig, prefersReducedMotion } from '../animations';
import { getGlassColors, getPickerModalProps } from '../glassStyles';
import { DateCalendarPanel } from './DateCalendarPanel';
import { DateQuickButtons } from './DateQuickButtons';
import { PickerHeader } from './PickerHeader';
import { PickerTimeCard } from './PickerTimeCard';
import { PickerDoneButton } from './PickerDoneButton';
import { formatLocalDateKey, parseReminderDateValue } from '../../utils/reminderDate';
import { buildDatePickerDateSelection, buildDatePickerTimeSelection } from './datePickerSelection';

interface DatePickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    animationConfig: AnimationConfig;
    pickerMode: 'replace' | 'overlay';
    dueDate: string | null;
    hasTime?: boolean;
    isDark: boolean;
    onDateTimeChange: (value: string, hasTime: boolean) => void;
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
    const glass = getGlassColors(isDark);
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

    const selectedDateDisplay = useMemo(() => {
        if (!currentDate) return null;
        const now = new Date();
        if (isSameDay(currentDate, now)) return 'Today';
        if (isSameDay(currentDate, addDays(now, 1))) return 'Tomorrow';
        return format(currentDate, 'EEE, MMM d');
    }, [currentDate]);

    const selectedTimeDisplay = useMemo(() => {
        if (!currentDate || !hasTime) return '09:00';
        return format(currentDate, 'HH:mm');
    }, [currentDate, hasTime]);

    const handleQuickDate = useCallback((date: Date) => {
        const selection = buildDatePickerDateSelection(
            date,
            parseReminderDateValue(dueDate, hasTime) ?? null,
            hasTime ?? false,
        );
        onDateTimeChange(selection.value, selection.hasTime);
        setDisplayMonth(parseDate(formatLocalDateKey(date)));
    }, [dueDate, hasTime, onDateTimeChange]);

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

    return (
        <BaseModal
            isOpen={isOpen}
            onClose={onClose}
            animationConfig={animationConfig}
            {...modalProps}
        >
            <div className={isDark ? 'dark text-foreground' : ''}>
                <PickerHeader
                    onBack={onClose}
                    isDark={isDark}
                    title={selectedDateDisplay || 'Select Date'}
                    subtitle={currentDate ? selectedTimeDisplay : undefined}
                />

                <DateQuickButtons
                    currentDate={currentDate}
                    glass={glass}
                    onSelectDate={handleQuickDate}
                />

                <DateCalendarPanel
                    currentDate={currentDate}
                    displayMonth={displayMonth}
                    calendarDirection={calendarDirection}
                    animationsEnabled={animationsEnabled}
                    glass={glass}
                    isDark={isDark}
                    onPrevMonth={handlePrevMonth}
                    onNextMonth={handleNextMonth}
                    onDateChange={handleCalendarDateChange}
                />

                {/* Time Section */}
                <div className="mx-4 mt-4">
                    <PickerTimeCard
                        isDark={isDark}
                        hour={currentDate ? (hasTime ? currentDate.getHours() : 9) : 9}
                        minute={currentDate ? (hasTime ? currentDate.getMinutes() : 0) : 0}
                        onChange={handleTimeChange}
                    />
                </div>

                <PickerDoneButton onClick={onClose} />
            </div>
        </BaseModal>
    );
};
