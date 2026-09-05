import React, { useEffect, useState, useMemo } from 'react';

import { BaseModal } from '../../components/BaseModal';
import { ModalHeader } from '../../components/ModalHeader';
import type { AnimationConfig } from '../animations';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { RecurrenceRule } from '../../types';
import { getPickerModalProps } from '../glassStyles';
import { PickerTimeCard } from './PickerTimeCard';
import { PickerContent } from './PickerContent';
import { PickerCurrentSummary } from './PickerCurrentSummary';
import { PickerSection } from './PickerSection';
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
    const reduceMotion = useObsidianReducedMotion();
    const animationsEnabled = animationConfig.enabled && !reduceMotion;
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
            className={`crate-reminder-picker-surface is-recurrence-picker${reduceMotion ? ' is-reduced-motion' : ''}`}
            ariaLabel={REMINDER_PICKER_COPY.repeat.dialogLabel}
            {...modalProps}
        >
            <div className={`reminder-picker reminder-recurrence-picker${isDark ? ' dark' : ''}`}>
                <ModalHeader
                    onClose={onClose}
                    closeLabel={REMINDER_PICKER_COPY.repeat.closeLabel}
                    title={REMINDER_PICKER_COPY.repeat.title}
                    action={{
                        label: REMINDER_PICKER_COPY.repeat.done,
                        onClick: handleDone,
                    }}
                />

                <div className="reminder-picker-scroll">
                    <PickerContent>
                        <PickerCurrentSummary
                            label={REMINDER_PICKER_COPY.repeat.current}
                            value={summaryText}
                            icon="repeat"
                        />

                        <PickerSection
                            headingId="plugin-repeat-frequency-title"
                            title={REMINDER_PICKER_COPY.repeat.frequency}
                        >
                            <RecurrenceFrequencyTabs
                                frequency={frequency}
                                onChange={setFrequency}
                            />
                        </PickerSection>

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

                        <PickerSection
                            headingId="plugin-repeat-time-title"
                            title={REMINDER_PICKER_COPY.repeat.time}
                            className="recurrence-picker-time"
                        >
                            <PickerTimeCard
                                label={REMINDER_PICKER_COPY.repeat.reminderTime}
                                controlIcon="clock"
                                hour={hour}
                                minute={minute}
                                onChange={(h, m) => { setHour(h); setMinute(m); }}
                            />
                        </PickerSection>
                    </PickerContent>

                    {recurrence && <PickerDoneButton
                        showPrimary={false}
                        removeAction={recurrence ? {
                            label: REMINDER_PICKER_COPY.repeat.remove,
                            onClick: handleRemoveRepeat,
                        } : undefined}
                    />}
                </div>
            </div>
        </BaseModal>
    );
};
