import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { ObsidianIcon } from '../../components/obsidian-icon';

interface PickerNativeControlProps {
	icon: string;
	hasValue: boolean;
	emptyLabel: string;
	invalid?: boolean;
	children: ReactNode;
}

export function PickerNativeControl({ icon, hasValue, emptyLabel, invalid = false, children }: PickerNativeControlProps) {
	const handleAffordancePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!(event.target instanceof Element)
			|| !event.target.closest('.picker-native-control-affordance')) return;

		const input = event.currentTarget.querySelector<HTMLInputElement>('input[data-picker-proxy]')
			?? event.currentTarget.querySelector<HTMLInputElement>('input');
		if (!input) return;

		event.preventDefault();
		try {
			input.showPicker();
		} catch {
			input.focus();
		}
	};

	return (
		<div
			className={`picker-native-control${hasValue ? ' has-value' : ''}${invalid ? ' is-invalid' : ''}`}
			onPointerDown={handleAffordancePointerDown}
		>
			<span className="picker-native-control-affordance is-leading" aria-hidden="true">
				<ObsidianIcon size="xs" id={icon} />
			</span>
			<span className="picker-native-control-value">
				{!hasValue && <span className="picker-native-control-empty">{emptyLabel}</span>}
				{children}
			</span>
		</div>
	);
}
