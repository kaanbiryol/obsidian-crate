import type { ComponentProps } from 'react';
import { BaseModal } from '../../../../ui/shared/BaseModal';
import { ThemeIconProvider } from '../../../../ui/shared/ThemeIcon';
import { ObsidianIcon } from '../../../../ui/obsidian-icon';
import type { AnimationConfig } from '../../../../ui/shared/component-adapter';
import { getPickerModalProps } from '../glassStyles';
import { useReducedMotion } from '../../../../ui/shared/useReducedMotion';
import { ProjectPickerContent } from '../../reminder-editor/ProjectPickerContent';
import { REMINDER_PICKER_COPY } from '../../reminder-editor/pickerCopy';

type ProjectPickerModalProps = ComponentProps<typeof ProjectPickerContent> & {
	animationConfig: AnimationConfig;
	pickerMode: 'replace' | 'overlay';
	finalFocus?: () => HTMLElement | false | null;
};

export function ProjectPickerModal({ animationConfig, pickerMode, finalFocus, ...props }: ProjectPickerModalProps) {
	const reduceMotion = useReducedMotion();
	return (
		<BaseModal
			finalFocus={finalFocus}
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
