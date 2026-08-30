import { Clock } from 'lucide-react';

interface PickerTimeCardProps {
	hour: number;
	minute: number;
	onChange: (hour: number, minute: number) => void;
}

export function PickerTimeCard({ hour, minute, onChange }: PickerTimeCardProps) {
	const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

	return (
		<div className="picker-time-card">
			<div className="flex items-center gap-3">
				<Clock
					size={16}
					strokeWidth={1.75}
					className="picker-time-icon"
				/>
				<span className="picker-time-label">
					Time
				</span>
				<div className="ml-auto">
					<input
						type="time"
						aria-label="Time"
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
				</div>
			</div>
		</div>
	);
}
