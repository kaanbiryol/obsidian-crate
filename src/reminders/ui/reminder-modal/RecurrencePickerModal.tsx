import { RecurrencePickerContent } from './RecurrencePickerContent';
import { ThemeIconProvider } from '../../components/theme-icon';
import { ObsidianIcon } from '../../components/obsidian-icon';
import React, { useEffect, useMemo, useState } from 'react';

import { BaseModal } from '../../components/BaseModal';
import type { AnimationConfig } from '../animations';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { RecurrenceRule } from '../../types';
import { getPickerModalProps } from '../glassStyles';
import {
	buildRecurrencePickerState,
	isRecurrencePickerStateUnchanged,
	recurrenceRuleFromPickerState,
} from './recurrencePickerShared';
import { REMINDER_PICKER_COPY } from './pickerCopy';

interface RecurrencePickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    finalFocus?: () => HTMLElement | false | null;
    animationConfig: AnimationConfig;
    pickerMode: 'replace' | 'overlay';
    isDark: boolean;
    recurrence?: RecurrenceRule;
    onApply: (rule: RecurrenceRule | undefined) => void;
}

export const RecurrencePickerModal: React.FC<RecurrencePickerModalProps> = ({
    isOpen,
    onClose,
    finalFocus,
    animationConfig,
    pickerMode,
    isDark,
    recurrence,
    onApply,
}) => {
    const reduceMotion = useObsidianReducedMotion();
    const animationsEnabled = animationConfig.enabled && !reduceMotion;
    const modalProps = getPickerModalProps(pickerMode);

    const initialState = useMemo(() => buildRecurrencePickerState(recurrence, 1), [recurrence]);
    const [state, setState] = useState(initialState);

    useEffect(() => {
        if (!isOpen) return;
        setState(initialState);
    }, [isOpen, initialState]);

    const handleDone = () => {
        if (!recurrence || !isRecurrencePickerStateUnchanged(state, initialState)) {
            onApply(recurrenceRuleFromPickerState(state, recurrence?.timezone));
        }
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
            finalFocus={finalFocus}
            animationConfig={animationConfig}
            className={`crate-reminder-picker-surface is-recurrence-picker${reduceMotion ? ' is-reduced-motion' : ''}`}
            ariaLabel={REMINDER_PICKER_COPY.repeat.dialogLabel}
            {...modalProps}
        >
            <ThemeIconProvider renderer={ObsidianIcon}>
                <RecurrencePickerContent
                    state={state}
                    onChange={(patch) => setState(current => ({ ...current, ...patch,
                        ...(patch.hour !== undefined || patch.minute !== undefined ? { second: undefined, millisecond: undefined } : {}),
                    }))}
                    isDark={isDark} animationsEnabled={animationsEnabled} canRemove={Boolean(recurrence)}
                    onClose={onClose} onDone={handleDone} onRemove={handleRemoveRepeat}
                />
            </ThemeIconProvider>
        </BaseModal>
    );
};
