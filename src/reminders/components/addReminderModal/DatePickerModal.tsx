import React, { useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { parseDate, today, getLocalTimeZone, CalendarDate } from '@internationalized/date';
import { Calendar } from '@heroui/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { format, addDays, isSameDay, nextMonday } from 'date-fns';

import { BaseModal } from '../BaseModal';
import { AnimationConfig, prefersReducedMotion } from '../../ui/animations';
import { ShadowDOMNativeButton } from '../ShadowDOMButton';
import { getGlassColors, getPickerModalProps } from '../../ui/glassStyles';
import { PickerHeader } from './PickerHeader';
import { PickerTimeCard } from './PickerTimeCard';
import { PickerDoneButton } from './PickerDoneButton';

interface DatePickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    animationConfig: AnimationConfig;
    pickerMode: 'replace' | 'overlay';
    dueDate: string | null;
    isDark: boolean;
    onDateTimeChange: (isoDate: string) => void;
}

const calendarVariants = {
    enter: (direction: number) => ({
        x: direction > 0 ? 20 : -20,
        opacity: 0,
    }),
    center: {
        x: 0,
        opacity: 1,
        transition: {
            x: { duration: 0.2, ease: [0.2, 0, 0, 1] as const },
            opacity: { duration: 0.15 },
        },
    },
    exit: (direction: number) => ({
        x: direction < 0 ? 20 : -20,
        opacity: 0,
        transition: {
            x: { duration: 0.15, ease: [0.2, 0, 0, 1] as const },
            opacity: { duration: 0.1 },
        },
    }),
};

interface QuickDateOption {
    label: string;
    getDate: () => Date;
}

const QUICK_DATES: QuickDateOption[] = [
    { label: 'Today', getDate: () => new Date() },
    { label: 'Tomorrow', getDate: () => addDays(new Date(), 1) },
    { label: 'Next Week', getDate: () => nextMonday(new Date()) },
];

export const DatePickerModal: React.FC<DatePickerModalProps> = ({
    isOpen,
    onClose,
    animationConfig,
    pickerMode,
    dueDate,
    isDark,
    onDateTimeChange,
}) => {
    const animationsEnabled = animationConfig.enabled && !prefersReducedMotion();
    const currentDate = dueDate ? new Date(dueDate) : null;
    const glass = getGlassColors(isDark);
    const modalProps = getPickerModalProps(pickerMode);

    const [calendarDirection, setCalendarDirection] = useState(0);
    const [displayMonth, setDisplayMonth] = useState<CalendarDate>(() =>
        dueDate ? parseDate(dueDate.split('T')[0]) : today(getLocalTimeZone())
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
        if (!currentDate) return '09:00';
        return format(currentDate, 'HH:mm');
    }, [currentDate]);

    const handleQuickDate = useCallback((getDate: () => Date) => {
        const date = getDate();
        const existingDate = dueDate ? new Date(dueDate) : new Date();
        date.setHours(existingDate.getHours() || 9);
        date.setMinutes(existingDate.getMinutes() || 0);
        onDateTimeChange(date.toISOString());
        setDisplayMonth(parseDate(date.toISOString().split('T')[0]));
    }, [dueDate, onDateTimeChange]);

    const handleTimeChange = useCallback((hour: number, minute: number) => {
        const existingDate = dueDate ? new Date(dueDate) : new Date();
        existingDate.setHours(hour);
        existingDate.setMinutes(minute);
        onDateTimeChange(existingDate.toISOString());
    }, [dueDate, onDateTimeChange]);

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

                {/* Quick Date Shortcuts */}
                <div className="flex gap-2 px-4 pb-3">
                    {QUICK_DATES.map(({ label, getDate }) => {
                        const isActive = currentDate && isSameDay(currentDate, getDate());
                        return (
                            <ShadowDOMNativeButton
                                key={label}
                                onClick={() => handleQuickDate(getDate)}
                                className="flex-1 h-9 rounded-xl transition-all duration-150 active:scale-95"
                                style={{
                                    fontSize: '13px',
                                    fontWeight: 500,
                                    border: 'none',
                                    cursor: 'pointer',
                                    background: isActive ? glass.accent : glass.surface.bg,
                                    color: isActive ? 'white' : glass.text.secondary,
                                }}
                                onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                                    if (!isActive) {
                                        e.currentTarget.style.background = glass.surfaceHover.bg;
                                    }
                                }}
                                onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                                    if (!isActive) {
                                        e.currentTarget.style.background = glass.surface.bg;
                                    }
                                }}
                            >
                                {label}
                            </ShadowDOMNativeButton>
                        );
                    })}
                </div>

                {/* Calendar Section */}
                <div className="px-4 pt-2">
                    {/* Month Navigation */}
                    <div className="flex items-center justify-center gap-4 mb-3">
                        <ShadowDOMNativeButton
                            onClick={handlePrevMonth}
                            className="flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200 active:scale-95"
                            style={{
                                background: glass.surface.bg,
                                border: `1px solid ${glass.surface.border}`,
                                cursor: 'pointer',
                                padding: 0,
                            }}
                            onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                                e.currentTarget.style.background = glass.surfaceHover.bg;
                                e.currentTarget.style.borderColor = glass.surfaceHover.border;
                            }}
                            onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                                e.currentTarget.style.background = glass.surface.bg;
                                e.currentTarget.style.borderColor = glass.surface.border;
                            }}
                        >
                            <ChevronLeft
                                size={18}
                                strokeWidth={2}
                                style={{ color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)' }}
                            />
                        </ShadowDOMNativeButton>

                        <span
                            style={{
                                fontSize: '16px',
                                fontWeight: 600,
                                color: 'var(--text-normal)',
                                letterSpacing: '-0.01em',
                                minWidth: '140px',
                                textAlign: 'center',
                            }}
                        >
                            {format(new Date(displayMonth.year, displayMonth.month - 1), 'MMMM yyyy')}
                        </span>

                        <ShadowDOMNativeButton
                            onClick={handleNextMonth}
                            className="flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200 active:scale-95"
                            style={{
                                background: glass.surface.bg,
                                border: `1px solid ${glass.surface.border}`,
                                cursor: 'pointer',
                                padding: 0,
                            }}
                            onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                                e.currentTarget.style.background = glass.surfaceHover.bg;
                                e.currentTarget.style.borderColor = glass.surfaceHover.border;
                            }}
                            onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                                e.currentTarget.style.background = glass.surface.bg;
                                e.currentTarget.style.borderColor = glass.surface.border;
                            }}
                        >
                            <ChevronRight
                                size={18}
                                strokeWidth={2}
                                style={{ color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)' }}
                            />
                        </ShadowDOMNativeButton>
                    </div>

                    {/* Calendar Grid */}
                    <div style={{ minHeight: '280px' }}>
                        <AnimatePresence mode="wait" custom={calendarDirection}>
                            <motion.div
                                key={`${displayMonth.year}-${displayMonth.month}`}
                                custom={calendarDirection}
                                variants={animationsEnabled ? calendarVariants : undefined}
                                initial={animationsEnabled ? "enter" : false}
                                animate="center"
                                exit={animationsEnabled ? "exit" : undefined}
                                className="flex justify-center"
                            >
                                <Calendar
                                    aria-label="Date picker"
                                    showShadow={false}
                                    value={dueDate ? parseDate(dueDate.split('T')[0]) : undefined}
                                    defaultFocusedValue={displayMonth}
                                    focusedValue={displayMonth}
                                    onChange={(date) => {
                                        if (date) {
                                            const existingDate = dueDate ? new Date(dueDate) : new Date();
                                            const newDate = new Date(date.year, date.month - 1, date.day);
                                            newDate.setHours(existingDate.getHours() || 9);
                                            newDate.setMinutes(existingDate.getMinutes() || 0);
                                            onDateTimeChange(newDate.toISOString());
                                            setDisplayMonth(date);
                                        }
                                    }}
                                    classNames={{
                                        base: '!bg-transparent !shadow-none !border-none w-full max-w-[320px]',
                                        content: '!bg-transparent !shadow-none !border-none w-full',
                                        headerWrapper: 'hidden',
                                        gridWrapper: 'pb-0 w-full !border-none',
                                        grid: 'gap-0 w-full !border-none',
                                        gridBody: '!border-none',
                                        gridHeader: 'pb-2 !border-none',
                                        gridHeaderRow: '!border-none',
                                        gridHeaderCell: 'w-10 h-8 text-[11px] font-semibold text-[var(--text-faint)] uppercase tracking-wider !border-none',
                                        cell: 'w-10 h-10 flex items-center justify-center !border-none',
                                        cellButton: [
                                            'w-8 h-8 text-[13px] font-medium rounded-full',
                                            'transition-transform duration-150',
                                            '!border-none !outline-none',
                                            'data-[selected=true]:bg-[hsl(var(--heroui-primary))]',
                                            'data-[selected=true]:text-white data-[selected=true]:font-semibold',
                                            'data-[selected=true]:shadow-[0_0_12px_hsl(var(--heroui-primary)/0.5)]',
                                            'data-[today=true]:font-bold data-[today=true]:text-[var(--interactive-accent)]',
                                            'data-[today=true]:shadow-[0_0_8px_var(--interactive-accent)/0.3]',
                                            'data-[outside-month=true]:text-[var(--text-faint)] data-[outside-month=true]:opacity-25',
                                            'hover:bg-[var(--background-modifier-hover)] active:scale-95',
                                        ].join(' '),
                                    }}
                                />
                            </motion.div>
                        </AnimatePresence>
                    </div>
                </div>

                {/* Time Section */}
                <div className="mx-4 mt-4">
                    <PickerTimeCard
                        isDark={isDark}
                        hour={currentDate?.getHours() ?? 9}
                        minute={currentDate?.getMinutes() ?? 0}
                        onChange={handleTimeChange}
                    />
                </div>

                <PickerDoneButton onClick={onClose} />
            </div>
        </BaseModal>
    );
};
