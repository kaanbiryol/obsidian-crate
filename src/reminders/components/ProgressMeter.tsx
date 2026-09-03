import { memo } from 'react';

interface ProgressMeterProps {
	percentage: number;
	label: string;
	color?: string;
	className?: string;
	fillClassName?: string;
}

export const ProgressMeter = memo(function ProgressMeter({
	percentage,
	label,
	color,
	className,
	fillClassName,
}: ProgressMeterProps) {
	const boundedPercentage = Math.min(100, Math.max(0, percentage));

	return (
		<div
			className={['crate-progress-meter', className].filter(Boolean).join(' ')}
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={boundedPercentage}
		>
			<div
				className={['crate-progress-meter-fill', fillClassName].filter(Boolean).join(' ')}
				style={{
					width: `${boundedPercentage}%`,
					backgroundColor: color,
				}}
			/>
		</div>
	);
});
