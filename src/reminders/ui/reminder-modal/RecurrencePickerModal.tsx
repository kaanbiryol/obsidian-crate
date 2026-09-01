import React, { useEffect, useState, useMemo } from 'react';

import { BaseModal } from '../../components/BaseModal';
import { AnimationConfig, prefersReducedMotion } from '../animations';
import { RecurrenceRule } from '../../types';
import { getPickerModalProps } from '../glassStyles';
import { PickerHeader } from './PickerHeader';
import { PickerTimeCard } from './PickerTimeCard';
import { RecurrenceFrequencyOptions } from './RecurrenceFrequencyOptions';
import { RecurrenceFrequencyTabs } from './RecurrenceFrequencyTabs';
import { PickerDoneButton } from './PickerDoneButton';
import {
	recurrenceRuleFromPickerState,
	summarizeRecurrencePickerState,
} from './recurrencePickerShared';
import { REMINDER_PICKER_COPY } from './pickerCopy';

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

    const handleRemoveRepeat = () => {
        onApply(undefined);
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
            className="crate-reminder-picker-surface is-recurrence-picker"
            {...modalProps}
        >
            <div className={`reminder-picker reminder-recurrence-picker${isDark ? ' dark' : ''}`}>
                <PickerHeader
                    onBack={onClose}
                    closeLabel={REMINDER_PICKER_COPY.repeat.closeLabel}
                    title={REMINDER_PICKER_COPY.repeat.title}
                    actionLabel={REMINDER_PICKER_COPY.repeat.done}
                    onAction={handleDone}
                />

                <div className="reminder-picker-scroll">
                    <div className="recurrence-picker-content">
                        <div className="picker-current-summary" aria-live="polite">
                            <span>{REMINDER_PICKER_COPY.repeat.current}</span>
                            <strong>{summaryText}</strong>
                        </div>

                        <section className="picker-section" aria-labelledby="plugin-repeat-frequency-title">
                            <div className="picker-section-heading">
                                <h4 id="plugin-repeat-frequency-title">{REMINDER_PICKER_COPY.repeat.frequency}</h4>
                            </div>
                            <RecurrenceFrequencyTabs
                                frequency={frequency}
                                onChange={setFrequency}
                            />
                        </section>

                        <section className="picker-section" aria-labelledby="plugin-repeat-options-title">
                            <div className="picker-section-heading">
                                <h4 id="plugin-repeat-options-title">
                                    {frequency === 'weekly'
                                        ? REMINDER_PICKER_COPY.repeat.days
                                        : frequency === 'monthly'
                                            ? REMINDER_PICKER_COPY.repeat.monthDay
                                            : REMINDER_PICKER_COPY.repeat.interval}
                                </h4>
                            </div>
                            <RecurrenceFrequencyOptions
                                frequency={frequency}
                                animationsEnabled={animationsEnabled}
                                interval={interval}
                                selectedDays={selectedDays}
                                dayOfMonth={dayOfMonth}
                                onIntervalChange={setInterval}
                                onToggleDay={toggleDay}
                                onDayOfMonthChange={setDayOfMonth}
                            />
                        </section>

                        <section className="picker-section recurrence-picker-time" aria-labelledby="plugin-repeat-time-title">
                            <div className="picker-section-heading">
                                <h4 id="plugin-repeat-time-title">{REMINDER_PICKER_COPY.repeat.time}</h4>
                            </div>
                            <PickerTimeCard
                                label={REMINDER_PICKER_COPY.repeat.reminderTime}
                                hour={hour}
                                minute={minute}
                                onChange={(h, m) => { setHour(h); setMinute(m); }}
                            />
                        </section>
                    </div>

                    <PickerDoneButton
                        showPrimary={false}
                        removeAction={recurrence ? {
                            label: REMINDER_PICKER_COPY.repeat.remove,
                            onClick: handleRemoveRepeat,
                        } : undefined}
                    />
                </div>
            </div>
        </BaseModal>
    );
};
