import React, { useEffect, useState, useMemo } from 'react';

import { BaseModal } from '../../components/BaseModal';
import { AnimationConfig, prefersReducedMotion } from '../animations';
import { RecurrenceRule } from '../../types';
import { getGlassColors, getPickerModalProps } from '../glassStyles';
import { PickerHeader } from './PickerHeader';
import { PickerTimeCard } from './PickerTimeCard';
import { RecurrenceFrequencyOptions } from './RecurrenceFrequencyOptions';
import { RecurrenceFrequencyTabs } from './RecurrenceFrequencyTabs';
import { PickerDoneButton } from './PickerDoneButton';
import {
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
                    <RecurrenceFrequencyTabs
                        frequency={frequency}
                        glass={glass}
                        isDark={isDark}
                        onChange={setFrequency}
                    />

                    <RecurrenceFrequencyOptions
                        frequency={frequency}
                        animationsEnabled={animationsEnabled}
                        glass={glass}
                        interval={interval}
                        selectedDays={selectedDays}
                        dayOfMonth={dayOfMonth}
                        onIntervalChange={setInterval}
                        onToggleDay={toggleDay}
                        onDayOfMonthChange={setDayOfMonth}
                    />

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
