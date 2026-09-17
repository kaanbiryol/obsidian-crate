import { Progress } from '@base-ui/react/progress';
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
		<Progress.Root
			value={boundedPercentage}
			className={['crate-progress-meter', className].filter(Boolean).join(' ')}
			aria-label={label}
		>
			<Progress.Indicator
				className={['crate-progress-meter-fill', fillClassName].filter(Boolean).join(' ')}
				style={{
					backgroundColor: color,
				}}
			/>
		</Progress.Root>
	);
});
