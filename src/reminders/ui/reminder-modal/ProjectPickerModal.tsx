import type { ComponentProps } from 'react';
import { BaseModal } from '../../components/BaseModal';
import { ThemeIconProvider } from '../../components/theme-icon';
import { ObsidianIcon } from '../../components/obsidian-icon';
import type { AnimationConfig } from '../animations';
import { getPickerModalProps } from '../glassStyles';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';
import { ProjectPickerContent } from './ProjectPickerContent';
import { REMINDER_PICKER_COPY } from './pickerCopy';

type ProjectPickerModalProps = ComponentProps<typeof ProjectPickerContent> & {
    animationConfig: AnimationConfig;
    pickerMode: 'replace' | 'overlay';
};

export function ProjectPickerModal({ animationConfig, pickerMode, ...props }: ProjectPickerModalProps) {
    const reduceMotion = useObsidianReducedMotion();
    return (
        <BaseModal
            isOpen={props.isOpen} onClose={props.onClose} animationConfig={animationConfig}
            className={`crate-reminder-picker-surface is-project-picker${reduceMotion ? ' is-reduced-motion' : ''}`}
            ariaLabel={REMINDER_PICKER_COPY.project.dialogLabel}
            {...getPickerModalProps(pickerMode)}
        >
            <ThemeIconProvider renderer={ObsidianIcon}>
                <ProjectPickerContent {...props} />
            </ThemeIconProvider>
        </BaseModal>
    );
}
