import React, { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

import { BaseModal } from '../BaseModal';
import { AnimationConfig, prefersReducedMotion } from '../../ui/animations';
import { RecurrenceRule } from '../../types';
import { ShadowDOMNativeButton } from '../ShadowDOMButton';
import { getGlassColors, getPickerModalProps } from '../../ui/glassStyles';
import { PickerHeader } from './PickerHeader';
import { PickerTimeCard } from './PickerTimeCard';
import { PickerDoneButton } from './PickerDoneButton';
import {
	RECURRENCE_DAY_LABELS,
	RECURRENCE_FREQUENCIES,
	RECURRENCE_FREQUENCY_LABELS,
	getOrdinalSuffix,
	recurrenceRuleFromPickerState,
	summarizeRecurrencePickerState,
} from './recurrencePickerShared';

interface RecurrencePickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    animationConfig: AnimationConfig;
    pickerMode: 'replace' | 'overlay';
    isDark: boolean;
    recurrence?: RecurrenceRule;
    onApply: (rule: RecurrenceRule | undefined) => void;
}

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
    const glass = getGlassColors(isDark);
    const modalProps = getPickerModalProps(pickerMode);

    const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>(recurrence?.frequency || 'daily');
    const [interval, setInterval] = useState<number>(recurrence?.interval || 1);
    const [selectedDays, setSelectedDays] = useState<number[]>(recurrence?.daysOfWeek || []);
    const [dayOfMonth, setDayOfMonth] = useState<number>(recurrence?.dayOfMonth || 1);
    const [hour, setHour] = useState<number>(recurrence?.hour ?? 9);
    const [minute, setMinute] = useState<number>(recurrence?.minute ?? 0);

    useEffect(() => {
        if (!isOpen) return;
        setFrequency(recurrence?.frequency || 'daily');
        setInterval(recurrence?.interval || 1);
        setSelectedDays(recurrence?.daysOfWeek || []);
        setDayOfMonth(recurrence?.dayOfMonth || 1);
        setHour(recurrence?.hour ?? 9);
        setMinute(recurrence?.minute ?? 0);
    }, [isOpen, recurrence]);

    const summaryText = useMemo(() => {
        return summarizeRecurrencePickerState({
            frequency,
            interval,
            daysOfWeek: selectedDays,
            dayOfMonth,
            hour,
            minute,
        });
    }, [frequency, interval, selectedDays, dayOfMonth, hour, minute]);

    const handleDone = () => {
        onApply(recurrenceRuleFromPickerState({
            frequency,
            interval,
            daysOfWeek: selectedDays,
            dayOfMonth,
            hour,
            minute,
        }));
        onClose();
    };

    const toggleDay = (dayIndex: number) => {
        setSelectedDays(prev =>
            prev.includes(dayIndex)
                ? prev.filter(d => d !== dayIndex)
                : [...prev, dayIndex].sort((a, b) => a - b)
        );
    };

    const frequencyIndex = RECURRENCE_FREQUENCIES.indexOf(frequency);

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
                    title={summaryText}
                />

                <div style={{ padding: '0 16px 0' }}>
                    {/* Segmented Control with sliding indicator */}
                    <div
                        className="relative"
                        style={{
                            display: 'flex',
                            padding: 4,
                            borderRadius: 14,
                            background: glass.surface.bg,
                            border: `1px solid ${glass.surface.border}`,
                        }}
                    >
                        {/* Sliding indicator */}
                        <motion.div
                            layout
                            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                            style={{
                                position: 'absolute',
                                top: 4,
                                bottom: 4,
                                left: `calc(${frequencyIndex * (100 / 3)}% + 4px)`,
                                width: `calc(${100 / 3}% - 8px)`,
                                borderRadius: 10,
                                background: glass.accent,
                                boxShadow: isDark
                                    ? '0 2px 8px hsl(var(--heroui-primary) / 0.3)'
                                    : '0 2px 8px hsl(var(--heroui-primary) / 0.2)',
                            }}
                        />
                        {RECURRENCE_FREQUENCIES.map((freq) => {
                            const isSelected = frequency === freq;
                            return (
                                <ShadowDOMNativeButton
                                    key={freq}
                                    onClick={() => setFrequency(freq)}
                                    style={{
                                        flex: 1,
                                        height: 36,
                                        borderRadius: 10,
                                        border: 'none',
                                        background: 'transparent',
                                        color: isSelected ? 'white' : glass.text.secondary,
                                        fontSize: 13,
                                        fontWeight: isSelected ? 600 : 500,
                                        cursor: 'pointer',
                                        position: 'relative',
                                        zIndex: 1,
                                        transition: 'color 150ms ease',
                                    }}
                                >
                                    {RECURRENCE_FREQUENCY_LABELS[freq]}
                                </ShadowDOMNativeButton>
                            );
                        })}
                    </div>

                    {/* Frequency-specific options */}
                    <div style={{ minHeight: 90, marginTop: 16 }}>
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={frequency}
                                initial={animationsEnabled ? { opacity: 0 } : false}
                                animate={{ opacity: 1 }}
                                exit={animationsEnabled ? { opacity: 0 } : undefined}
                                transition={{ duration: 0.15 }}
                                style={{
                                    minHeight: 90,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    justifyContent: 'center',
                                }}
                            >
                                {/* Daily: Interval stepper */}
                                {frequency === 'daily' && (
                                    <div
                                        className="flex items-center justify-center gap-3"
                                        style={{
                                            padding: '12px 16px',
                                            borderRadius: 12,
                                            background: glass.surface.bg,
                                            border: `1px solid ${glass.surface.border}`,
                                        }}
                                    >
                                        <span style={{ fontSize: 14, color: glass.text.secondary }}>
                                            Every
                                        </span>
                                        <div className="flex items-center gap-1">
                                            <ShadowDOMNativeButton
                                                onClick={() => setInterval(prev => Math.max(1, prev - 1))}
                                                className="flex items-center justify-center w-9 h-9 rounded-lg active:scale-95"
                                                style={{
                                                    background: glass.surfaceHover.bg,
                                                    border: `1px solid ${glass.surface.border}`,
                                                    color: glass.text.primary,
                                                    fontSize: 16,
                                                    fontWeight: 600,
                                                    cursor: 'pointer',
                                                    opacity: interval <= 1 ? 0.3 : 1,
                                                }}
                                            >
                                                -
                                            </ShadowDOMNativeButton>
                                            <span
                                                style={{
                                                    minWidth: 32,
                                                    textAlign: 'center',
                                                    fontSize: 16,
                                                    fontWeight: 700,
                                                    color: glass.text.primary,
                                                }}
                                            >
                                                {interval}
                                            </span>
                                            <ShadowDOMNativeButton
                                                onClick={() => setInterval(prev => Math.min(30, prev + 1))}
                                                className="flex items-center justify-center w-9 h-9 rounded-lg active:scale-95"
                                                style={{
                                                    background: glass.surfaceHover.bg,
                                                    border: `1px solid ${glass.surface.border}`,
                                                    color: glass.text.primary,
                                                    fontSize: 16,
                                                    fontWeight: 600,
                                                    cursor: 'pointer',
                                                }}
                                            >
                                                +
                                            </ShadowDOMNativeButton>
                                        </div>
                                        <span style={{ fontSize: 14, color: glass.text.secondary }}>
                                            {interval === 1 ? 'day' : 'days'}
                                        </span>
                                    </div>
                                )}

                                {/* Weekly: Day selector */}
                                {frequency === 'weekly' && (
                                    <div>
                                        <div style={{
                                            fontSize: 11,
                                            fontWeight: 500,
                                            color: glass.text.tertiary,
                                            textTransform: 'uppercase',
                                            letterSpacing: '0.04em',
                                            marginBottom: 10,
                                        }}>
                                            Repeat on
                                        </div>
                                        <div style={{ display: 'flex', gap: 6 }}>
                                            {RECURRENCE_DAY_LABELS.map((label, idx) => {
                                                const isSelected = selectedDays.includes(idx);
                                                return (
                                                    <ShadowDOMNativeButton
                                                        key={idx}
                                                        onClick={() => toggleDay(idx)}
                                                        style={{
                                                            flex: 1,
                                                            aspectRatio: '1',
                                                            maxWidth: 44,
                                                            borderRadius: 12,
                                                            border: 'none',
                                                            background: isSelected ? glass.accent : glass.surface.bg,
                                                            color: isSelected ? 'white' : glass.text.secondary,
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

                                {/* Monthly: Day stepper */}
                                {frequency === 'monthly' && (
                                    <div
                                        className="flex items-center justify-center gap-3"
                                        style={{
                                            padding: '12px 16px',
                                            borderRadius: 12,
                                            background: glass.surface.bg,
                                            border: `1px solid ${glass.surface.border}`,
                                        }}
                                    >
                                        <span style={{ fontSize: 14, color: glass.text.secondary }}>
                                            Day
                                        </span>
                                        <div className="flex items-center gap-1">
                                            <ShadowDOMNativeButton
                                                onClick={() => setDayOfMonth(prev => Math.max(1, prev - 1))}
                                                className="flex items-center justify-center w-9 h-9 rounded-lg active:scale-95"
                                                style={{
                                                    background: glass.surfaceHover.bg,
                                                    border: `1px solid ${glass.surface.border}`,
                                                    color: glass.text.primary,
                                                    fontSize: 16,
                                                    fontWeight: 600,
                                                    cursor: 'pointer',
                                                    opacity: dayOfMonth <= 1 ? 0.3 : 1,
                                                }}
                                            >
                                                -
                                            </ShadowDOMNativeButton>
                                            <span
                                                style={{
                                                    minWidth: 40,
                                                    textAlign: 'center',
                                                    fontSize: 16,
                                                    fontWeight: 700,
                                                    color: glass.text.primary,
                                                }}
                                            >
                                                {getOrdinalSuffix(dayOfMonth)}
                                            </span>
                                            <ShadowDOMNativeButton
                                                onClick={() => setDayOfMonth(prev => Math.min(31, prev + 1))}
                                                className="flex items-center justify-center w-9 h-9 rounded-lg active:scale-95"
                                                style={{
                                                    background: glass.surfaceHover.bg,
                                                    border: `1px solid ${glass.surface.border}`,
                                                    color: glass.text.primary,
                                                    fontSize: 16,
                                                    fontWeight: 600,
                                                    cursor: 'pointer',
                                                    opacity: dayOfMonth >= 31 ? 0.3 : 1,
                                                }}
                                            >
                                                +
                                            </ShadowDOMNativeButton>
                                        </div>
                                        <span style={{ fontSize: 14, color: glass.text.secondary }}>
                                            of each month
                                        </span>
                                    </div>
                                )}
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    {/* Time picker */}
                    <div style={{ marginTop: 16 }}>
                        <PickerTimeCard
                            isDark={isDark}
                            hour={hour}
                            minute={minute}
                            onChange={(h, m) => { setHour(h); setMinute(m); }}
                        />
                    </div>
                </div>

                <PickerDoneButton onClick={handleDone} />
            </div>
        </BaseModal>
    );
};
