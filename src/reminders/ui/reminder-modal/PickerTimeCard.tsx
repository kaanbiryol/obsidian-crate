import { Clock } from 'lucide-react';

interface PickerTimeCardProps {
	label: string;
	optionalLabel?: string;
	hour: number;
	minute: number;
	onChange: (hour: number, minute: number) => void;
}

export function PickerTimeCard({ label, optionalLabel, hour, minute, onChange }: PickerTimeCardProps) {
	const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

	return (
		<label className="picker-time-card">
			<Clock
				size={16}
				strokeWidth={1.75}
				className="picker-time-icon"
			/>
			<span className="picker-time-label">
				{label}
				{optionalLabel && <small>{optionalLabel}</small>}
			</span>
			<input
				type="time"
				aria-label={label}
				value={value}
				onChange={(event) => {
					const [nextHour, nextMinute] = event.currentTarget.value
						.split(':')
						.map(part => Number.parseInt(part, 10));
					if (nextHour !== undefined && nextMinute !== undefined
						&& Number.isInteger(nextHour) && Number.isInteger(nextMinute)) {
						onChange(nextHour, nextMinute);
					}
				}}
				className="picker-time-input"
			/>
		</label>
	);
}
