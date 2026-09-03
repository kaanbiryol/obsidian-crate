interface PickerTimeCardProps {
	label: string;
	optionalLabel?: string;
	hour?: number;
	minute?: number;
	onChange: (hour: number, minute: number) => void;
	onClear?: () => void;
}

export function PickerTimeCard({ label, optionalLabel, hour, minute, onChange, onClear }: PickerTimeCardProps) {
	const value = hour === undefined || minute === undefined
		? ''
		: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

	return (
		<PickerFieldRow
			label={label}
			detail={optionalLabel}
			className="picker-time-card"
			asLabel
		>
			<input
				type="time"
				aria-label={label}
				value={value}
				onChange={(event) => {
					if (!event.currentTarget.value) {
						onClear?.();
						return;
					}
					const [nextHour, nextMinute] = event.currentTarget.value
						.split(':')
						.map(part => Number.parseInt(part, 10));
					if (nextHour !== undefined && nextMinute !== undefined
						&& Number.isInteger(nextHour) && Number.isInteger(nextMinute)) {
						onChange(nextHour, nextMinute);
					}
				}}
				className={`picker-time-input${value ? ' has-value' : ''}`}
			/>
		</PickerFieldRow>
	);
}
import { PickerFieldRow } from './PickerFieldRow';
