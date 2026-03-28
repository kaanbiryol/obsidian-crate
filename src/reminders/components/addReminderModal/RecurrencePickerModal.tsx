import React, { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, Clock } from 'lucide-react';
import { TimeInput } from '@heroui/react';
import { Time } from '@internationalized/date';

import { BaseModal } from '../BaseModal';
import { AnimationConfig, prefersReducedMotion } from '../../ui/animations';
import { RecurrenceRule } from '../../types';
import { ShadowDOMNativeButton } from '../ShadowDOMButton';

interface RecurrencePickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    animationConfig: AnimationConfig;
    pickerMode: 'replace' | 'overlay';
    isDark: boolean;
    recurrence?: RecurrenceRule;
    onApply: (rule: RecurrenceRule | undefined) => void;
}

const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_FULL_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const getOrdinalSuffix = (n: number): string => {
    if (n === -1) return 'Last';
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export const RecurrencePickerModal: React.FC<RecurrencePickerModalProps> = ({
    isOpen,
    onClose,
    animationConfig,
    pickerMode,
    isDark,
    recurrence,
    onApply,
}) => {
    const animationsEnabled = animationConfig.enabled && !prefersReducedMotion();

    const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>(recurrence?.frequency || 'daily');
    const [selectedDays, setSelectedDays] = useState<number[]>(recurrence?.daysOfWeek || []);
    const [dayOfMonth, setDayOfMonth] = useState<number>(recurrence?.dayOfMonth || 1);
    const [hour, setHour] = useState<number>(recurrence?.hour ?? 9);
    const [minute, setMinute] = useState<number>(recurrence?.minute ?? 0);

    // Minimal color palette
    const colors = {
        surface: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
        surfaceHover: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.07)',
        border: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
        textPrimary: 'var(--text-normal)',
        textSecondary: isDark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.45)',
        textTertiary: isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.3)',
        accent: 'hsl(var(--heroui-primary))',
        accentMuted: 'hsl(var(--heroui-primary) / 0.15)',
    };

    // Glass styling for header (matching ProjectPickerModal)
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

    useEffect(() => {
        if (!isOpen) return;
        setFrequency(recurrence?.frequency || 'daily');
        setSelectedDays(recurrence?.daysOfWeek || []);
        setDayOfMonth(recurrence?.dayOfMonth || 1);
        setHour(recurrence?.hour ?? 9);
        setMinute(recurrence?.minute ?? 0);
    }, [isOpen, recurrence]);

    const summaryText = useMemo(() => {
        const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        switch (frequency) {
            case 'daily':
                return `Daily at ${timeStr}`;
            case 'weekly':
                if (selectedDays.length === 0) return `Weekly at ${timeStr}`;
                if (selectedDays.length === 7) return `Every day at ${timeStr}`;
                const dayNames = selectedDays.map(d => DAY_FULL_NAMES[d]).join(', ');
                return `${dayNames} at ${timeStr}`;
            case 'monthly':
                return `${getOrdinalSuffix(dayOfMonth)} of month at ${timeStr}`;
        }
    }, [frequency, selectedDays, dayOfMonth, hour, minute]);

    const handleDone = () => {
        const rule: RecurrenceRule = { frequency, hour, minute };
        if (frequency === 'weekly' && selectedDays.length > 0) {
            rule.daysOfWeek = selectedDays;
        }
        if (frequency === 'monthly') {
            rule.dayOfMonth = dayOfMonth;
        }
        onApply(rule);
        onClose();
    };

    const toggleDay = (dayIndex: number) => {
        setSelectedDays(prev =>
            prev.includes(dayIndex)
                ? prev.filter(d => d !== dayIndex)
                : [...prev, dayIndex].sort((a, b) => a - b)
        );
    };

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
            <div className={isDark ? 'dark text-foreground' : ''}>
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

                    {/* Title - Premium typography */}
                    <span
                        style={{
                            fontSize: '20px',
                            fontWeight: 700,
                            color: 'var(--text-normal)',
                            letterSpacing: '-0.02em',
                        }}
                    >
                        {summaryText}
                    </span>

                    {/* Spacer for balance */}
                    <div className="w-9" />
                </div>

                {/* Content */}
                <div style={{ padding: '0 16px 16px' }}>
                    {/* Segmented Control - Minimal Pill Buttons */}
                    <div style={{
                        display: 'flex',
                        gap: 8,
                    }}>
                        {FREQUENCIES.map((freq) => {
                            const isSelected = frequency === freq;
                            return (
                                <ShadowDOMNativeButton
                                    key={freq}
                                    onClick={() => setFrequency(freq)}
                                    style={{
                                        flex: 1,
                                        height: 36,
                                        borderRadius: 12,
                                        border: 'none',
                                        background: isSelected
                                            ? colors.accent
                                            : colors.surface,
                                        color: isSelected
                                            ? 'white'
                                            : colors.textSecondary,
                                        fontSize: 13,
                                        fontWeight: 500,
                                        cursor: 'pointer',
                                        transition: 'all 150ms ease',
                                    }}
                                >
                                    {freq.charAt(0).toUpperCase() + freq.slice(1)}
                                </ShadowDOMNativeButton>
                            );
                        })}
                    </div>

                    {/* Frequency-specific options - Fixed height container to prevent modal jumping */}
                    <div style={{ minHeight: 75, marginTop: 16 }}>
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={frequency}
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.15 }}
                                style={{
                                    minHeight: 75,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    justifyContent: 'center',
                                }}
                            >
                                {/* Weekly: Day selector */}
                                {frequency === 'weekly' && (
                                    <div>
                                        <div style={{
                                            fontSize: 11,
                                            fontWeight: 500,
                                            color: colors.textTertiary,
                                            textTransform: 'uppercase',
                                            letterSpacing: '0.04em',
                                            marginBottom: 10,
                                        }}>
                                            Repeat on
                                        </div>
                                        <div style={{
                                            display: 'flex',
                                            gap: 6,
                                        }}>
                                            {DAY_LABELS.map((label, idx) => {
                                                const isSelected = selectedDays.includes(idx);
                                                return (
                                                    <ShadowDOMNativeButton
                                                        key={idx}
                                                        onClick={() => toggleDay(idx)}
                                                        style={{
                                                            flex: 1,
                                                            aspectRatio: '1',
                                                            maxWidth: 38,
                                                            borderRadius: 12,
                                                            border: 'none',
                                                            background: isSelected ? colors.accent : colors.surface,
                                                            color: isSelected ? 'white' : colors.textSecondary,
                                                            fontSize: 12,
                                                            fontWeight: 600,
                                                            cursor: 'pointer',
                                                            transition: 'all 150ms ease',
                                                        }}
                                                    >
                                                        {label}
                                                    </ShadowDOMNativeButton>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                {/* Monthly: Day of month */}
                                {frequency === 'monthly' && (
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 10,
                                    }}>
                                        <span style={{
                                            fontSize: 14,
                                            color: colors.textSecondary,
                                        }}>
                                            Day of month
                                        </span>
                                        <input
                                            type="number"
                                            min={1}
                                            max={31}
                                            value={dayOfMonth}
                                            onChange={(e) => {
                                                const val = parseInt(e.target.value, 10);
                                                if (!isNaN(val) && val >= 1 && val <= 31) {
                                                    setDayOfMonth(val);
                                                }
                                            }}
                                            style={{
                                                width: 56,
                                                height: 36,
                                                borderRadius: 12,
                                                border: `1px solid ${colors.border}`,
                                                background: 'transparent',
                                                color: colors.textPrimary,
                                                fontSize: 14,
                                                fontWeight: 600,
                                                textAlign: 'center',
                                                outline: 'none',
                                            }}
                                        />
                                    </div>
                                )}

                                {/* Daily: Simple text */}
                                {frequency === 'daily' && (
                                    <div style={{
                                        fontSize: 13,
                                        color: colors.textTertiary,
                                        textAlign: 'center',
                                    }}>
                                        Repeats every day
                                    </div>
                                )}
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    {/* Time picker - Glass card (outside animated section for stability) */}
                    <div
                        style={{
                            background: glassBackground,
                            border: `1px solid ${glassBorder}`,
                            borderRadius: '12px',
                            padding: '14px 16px',
                            marginTop: 16,
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
                                    value={new Time(hour, minute)}
                                    onChange={(time) => {
                                        if (time) {
                                            setHour(time.hour);
                                            setMinute(time.minute);
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

                    {/* Done button */}
                    <ShadowDOMNativeButton
                        onClick={handleDone}
                        style={{
                            width: '100%',
                            height: 44,
                            marginTop: 20,
                            borderRadius: 12,
                            border: 'none',
                            background: colors.accent,
                            color: 'white',
                            fontSize: 15,
                            fontWeight: 600,
                            cursor: 'pointer',
                            transition: 'opacity 150ms ease',
                        }}
                    >
                        Done
                    </ShadowDOMNativeButton>
                </div>
            </div>
        </BaseModal>
    );
};
