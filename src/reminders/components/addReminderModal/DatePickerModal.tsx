import React, { useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Time, parseDate, today, getLocalTimeZone, CalendarDate } from '@internationalized/date';
import { TimeInput, Calendar } from '@heroui/react';
import { ChevronLeft, Clock } from 'lucide-react';
import { format, addDays, isSameDay } from 'date-fns';

import { BaseModal } from '../BaseModal';
import { AnimationConfig, prefersReducedMotion } from '../../ui/animations';
import { ShadowDOMNativeButton } from '../ShadowDOMButton';

interface DatePickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    animationConfig: AnimationConfig;
    pickerMode: 'replace' | 'overlay';
    dueDate: string | null;
    isDark: boolean;
    onDateTimeChange: (isoDate: string) => void;
}

// Month navigation animation - Snappy 200ms transitions
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

    // Glass styling based on theme
    const glassBackButtonBg = isDark
        ? 'rgba(255, 255, 255, 0.04)'
        : 'rgba(0, 0, 0, 0.03)';
    const glassBackButtonBorder = isDark
        ? 'rgba(255, 255, 255, 0.08)'
        : 'rgba(0, 0, 0, 0.06)';
    const glassBackButtonHoverBg = isDark
        ? 'rgba(255, 255, 255, 0.08)'
        : 'rgba(0, 0, 0, 0.06)';
    const glassBackground = isDark
        ? 'rgba(255, 255, 255, 0.03)'
        : 'rgba(0, 0, 0, 0.02)';
    const glassBorder = isDark
        ? 'rgba(255, 255, 255, 0.06)'
        : 'rgba(0, 0, 0, 0.05)';
    const dividerGradient = isDark
        ? 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.08) 20%, rgba(255, 255, 255, 0.08) 80%, transparent 100%)'
        : 'linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.06) 20%, rgba(0, 0, 0, 0.06) 80%, transparent 100%)';

    // Track calendar month for navigation animation
    const [calendarDirection, setCalendarDirection] = useState(0);
    const [displayMonth, setDisplayMonth] = useState<CalendarDate>(() =>
        dueDate ? parseDate(dueDate.split('T')[0]) : today(getLocalTimeZone())
    );

    // Custom navigation handlers - React automatically batches these state updates
    const handlePrevMonth = useCallback(() => {
        setCalendarDirection(-1);
        setDisplayMonth(prev => prev.subtract({ months: 1 }));
    }, []);

    const handleNextMonth = useCallback(() => {
        setCalendarDirection(1);
        setDisplayMonth(prev => prev.add({ months: 1 }));
    }, []);

    // Format selected date for display
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

    return (
        <BaseModal
            isOpen={isOpen}
            onClose={onClose}
            animationConfig={animationConfig}
            variant={pickerMode === 'overlay' ? 'centered' : 'bottom-sheet'}
            performanceMode={pickerMode === 'overlay' ? 'standard' : 'reduced-effects'}
            showBackdrop={false}
            showDragHandle={pickerMode !== 'overlay'}
            zIndex={pickerMode === 'overlay' ? 70 : 60}
        >
            <div
                className={`${isDark ? 'dark text-foreground' : ''}`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 pt-2 pb-3">
                    {/* Back button - Glass styling */}
                    <ShadowDOMNativeButton
                        onClick={onClose}
                        className="flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200 active:scale-95"
                        style={{
                            background: glassBackButtonBg,
                            border: `1px solid ${glassBackButtonBorder}`,
                            color: 'var(--text-muted)',
                            boxShadow: `0 2px 8px ${isDark ? 'rgba(0, 0, 0, 0.12)' : 'rgba(0, 0, 0, 0.04)'}`,
                            transition: 'transform 200ms ease-out',
                        }}
                        onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                            e.currentTarget.style.background = glassBackButtonHoverBg;
                            e.currentTarget.style.boxShadow = `0 0 12px ${isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)'}`;
                        }}
                        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                            e.currentTarget.style.background = glassBackButtonBg;
                            e.currentTarget.style.boxShadow = `0 2px 8px ${isDark ? 'rgba(0, 0, 0, 0.12)' : 'rgba(0, 0, 0, 0.04)'}`;
                        }}
                    >
                        <ChevronLeft size={20} strokeWidth={2} />
                    </ShadowDOMNativeButton>

                    {/* Center: Selected date/time preview - Premium typography */}
                    <div className="flex flex-col items-center">
                        <span
                            style={{
                                fontSize: '20px',
                                fontWeight: 700,
                                color: 'var(--text-normal)',
                                letterSpacing: '-0.02em',
                            }}
                        >
                            {selectedDateDisplay || 'Select Date'}
                        </span>
                        {currentDate && (
                            <span
                                style={{
                                    fontSize: '13px',
                                    fontWeight: 500,
                                    color: 'var(--text-muted)',
                                    marginTop: '2px',
                                    opacity: 0.85,
                                }}
                            >
                                {selectedTimeDisplay}
                            </span>
                        )}
                    </div>

                    {/* Empty spacer to balance the layout */}
                    <div className="w-9" />
                </div>

                {/* Header divider - Gradient fade */}
                <div
                    style={{
                        height: '1px',
                        margin: '0 20px 8px',
                        background: dividerGradient,
                    }}
                />

                {/* Calendar Section */}
                <div className="px-4 pt-2">
                    {/* Custom Month Navigation - Glass styled */}
                    <div className="flex items-center justify-center gap-4 mb-3">
                        <ShadowDOMNativeButton
                            onClick={handlePrevMonth}
                            className="transition-all duration-200 active:scale-95"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: '34px',
                                height: '34px',
                                background: glassBackground,
                                border: `1px solid ${glassBorder}`,
                                borderRadius: '10px',
                                cursor: 'pointer',
                                padding: 0,
                                transition: 'transform 200ms ease-out',
                            }}
                            onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                                e.currentTarget.style.background = isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)';
                                e.currentTarget.style.borderColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)';
                            }}
                            onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                                e.currentTarget.style.background = glassBackground;
                                e.currentTarget.style.borderColor = glassBorder;
                            }}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke={isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)'}
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                style={{
                                    width: '18px',
                                    height: '18px',
                                    minWidth: '18px',
                                    minHeight: '18px',
                                    display: 'block',
                                }}
                            >
                                <path d="m15 18-6-6 6-6" />
                            </svg>
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
                            className="transition-all duration-200 active:scale-95"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: '34px',
                                height: '34px',
                                background: glassBackground,
                                border: `1px solid ${glassBorder}`,
                                borderRadius: '10px',
                                cursor: 'pointer',
                                padding: 0,
                                transition: 'transform 200ms ease-out',
                            }}
                            onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                                e.currentTarget.style.background = isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)';
                                e.currentTarget.style.borderColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)';
                            }}
                            onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                                e.currentTarget.style.background = glassBackground;
                                e.currentTarget.style.borderColor = glassBorder;
                            }}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke={isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)'}
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                style={{
                                    width: '18px',
                                    height: '18px',
                                    minWidth: '18px',
                                    minHeight: '18px',
                                    display: 'block',
                                }}
                            >
                                <path d="m9 18 6-6-6-6" />
                            </svg>
                        </ShadowDOMNativeButton>
                    </div>

                    {/* Calendar Grid with Animation - Fixed height to prevent jumping when changing months */}
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
                                    headerWrapper: 'hidden', // We use custom header
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

                {/* Time Section - Glass card */}
                <div
                    style={{
                        background: glassBackground,
                        border: `1px solid ${glassBorder}`,
                        borderRadius: '14px',
                        padding: '14px 16px',
                        margin: '16px 16px 0',
                    }}
                >
                    <div className="flex items-center gap-3">
                        <Clock
                            size={16}
                            strokeWidth={1.75}
                            style={{
                                color: 'var(--interactive-accent)',
                                filter: isDark ? 'drop-shadow(0 0 4px var(--interactive-accent))' : 'none',
                            }}
                        />
                        <span
                            style={{
                                fontSize: '14px',
                                fontWeight: 600,
                                color: 'var(--text-normal)',
                            }}
                        >
                            Time
                        </span>
                        <div className={`ml-auto ${isDark ? 'dark text-foreground' : ''}`}>
                            <TimeInput
                                aria-label="Time"
                                size="sm"
                                granularity="minute"
                                hourCycle={24}
                                value={dueDate ? new Time(new Date(dueDate).getHours(), new Date(dueDate).getMinutes()) : new Time(9, 0)}
                                onChange={(time) => {
                                    if (time) {
                                        const existingDate = dueDate ? new Date(dueDate) : new Date();
                                        existingDate.setHours(time.hour);
                                        existingDate.setMinutes(time.minute);
                                        onDateTimeChange(existingDate.toISOString());
                                    }
                                }}
                                classNames={{
                                    base: 'w-auto',
                                    inputWrapper: [
                                        'shadow-none',
                                        'h-9 min-h-9 px-3 rounded-xl',
                                        `bg-[${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'}]`,
                                        `border border-[${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}]`,
                                    ].join(' '),
                                    input: 'text-[14px] font-semibold text-[var(--text-normal)]',
                                    segment: 'text-[14px] font-semibold data-[placeholder=true]:text-[var(--text-muted)]',
                                }}
                            />
                        </div>
                    </div>
                </div>

                {/* Done Button - Premium glow effect */}
                <div className="px-4 pt-4 pb-2">
                    <ShadowDOMNativeButton
                        onClick={onClose}
                        className="w-full h-12 rounded-2xl transition-all duration-200 active:scale-[0.98]"
                        style={{
                            fontSize: '15px',
                            fontWeight: 600,
                            letterSpacing: '-0.01em',
                            background: 'linear-gradient(135deg, hsl(var(--heroui-primary)) 0%, hsl(var(--heroui-primary) / 0.85) 100%)',
                            color: 'white',
                            boxShadow: isDark
                                ? '0 0 24px hsl(var(--heroui-primary) / 0.4), 0 4px 16px hsl(var(--heroui-primary) / 0.3)'
                                : '0 4px 16px hsl(var(--heroui-primary) / 0.25), 0 2px 4px hsl(var(--heroui-primary) / 0.15)',
                            transition: 'all 200ms ease-out',
                        }}
                        onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                            e.currentTarget.style.boxShadow = isDark
                                ? '0 0 32px hsl(var(--heroui-primary) / 0.5), 0 4px 20px hsl(var(--heroui-primary) / 0.4)'
                                : '0 4px 20px hsl(var(--heroui-primary) / 0.35), 0 2px 8px hsl(var(--heroui-primary) / 0.2)';
                        }}
                        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                            e.currentTarget.style.boxShadow = isDark
                                ? '0 0 24px hsl(var(--heroui-primary) / 0.4), 0 4px 16px hsl(var(--heroui-primary) / 0.3)'
                                : '0 4px 16px hsl(var(--heroui-primary) / 0.25), 0 2px 4px hsl(var(--heroui-primary) / 0.15)';
                        }}
                    >
                        Done
                    </ShadowDOMNativeButton>
                </div>
            </div>
        </BaseModal>
    );
};
