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
			<label className={classes}>
				{copy}
				{children}
			</label>
		);
	}

	return (
		<div className={classes}>
			{copy}
			{children}
		</div>
	);
}
