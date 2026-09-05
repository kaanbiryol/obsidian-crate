import { RecurrencePickerContent } from './RecurrencePickerContent';
import { ThemeIconProvider } from '../../components/theme-icon';
import { ObsidianIcon } from '../../components/obsidian-icon';
import React, { useEffect, useState } from 'react';

import { BaseModal } from '../../components/BaseModal';
import type { AnimationConfig } from '../animations';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { RecurrenceRule } from '../../types';
import { getPickerModalProps } from '../glassStyles';
import {
	recurrenceRuleFromPickerState,
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

    return (
        <BaseModal
            isOpen={isOpen}
            onClose={onClose}
            animationConfig={animationConfig}
            className={`crate-reminder-picker-surface is-recurrence-picker${reduceMotion ? ' is-reduced-motion' : ''}`}
            ariaLabel={REMINDER_PICKER_COPY.repeat.dialogLabel}
            {...modalProps}
        >
            <ThemeIconProvider renderer={ObsidianIcon}>
                <RecurrencePickerContent
                    state={{ frequency, interval, daysOfWeek: selectedDays, dayOfMonth, hour, minute }}
                    onChange={(patch) => {
                        if (patch.frequency !== undefined) setFrequency(patch.frequency);
                        if (patch.interval !== undefined) setInterval(patch.interval);
                        if (patch.daysOfWeek !== undefined) setSelectedDays(patch.daysOfWeek);
                        if (patch.dayOfMonth !== undefined) setDayOfMonth(patch.dayOfMonth);
                        if (patch.hour !== undefined) setHour(patch.hour);
                        if (patch.minute !== undefined) setMinute(patch.minute);
                    }}
                    isDark={isDark} animationsEnabled={animationsEnabled} canRemove={Boolean(recurrence)}
                    onClose={onClose} onDone={handleDone} onRemove={handleRemoveRepeat}
                />
            </ThemeIconProvider>
        </BaseModal>
    );
};
