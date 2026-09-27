import { usePressFeedback } from '../../../ui/shared/usePressFeedback';
import type { ReactNode } from 'react';

interface PickerFieldRowProps {
	label: ReactNode;
	children: ReactNode;
	detail?: ReactNode;
	detailPlacement?: 'inline' | 'stacked';
	className?: string;
	asLabel?: boolean;
}

export function PickerFieldRow({
	label,
	children,
	detail,
	detailPlacement = 'inline',
	className,
	asLabel = false,
}: PickerFieldRowProps) {
	const { pressed, events } = usePressFeedback<HTMLElement>();
	const classes = ['picker-control-row', className].filter(Boolean).join(' ');
	const copy = (
		<span className="picker-field-copy">
			<strong>
				{label}
				{detail !== undefined && detailPlacement === 'inline' && <small>{detail}</small>}
			</strong>
			{detail !== undefined && detailPlacement === 'stacked' && <span>{detail}</span>}
		</span>
	);

	if (asLabel) {
		return (
			<label className={classes} {...events} data-press-active={pressed ? '' : undefined}>
				{copy}
				{children}
			</label>
		);
	}

	return (
		<div className={classes} {...events} data-press-active={pressed ? '' : undefined}>
			{copy}
			{children}
		</div>
	);
}
