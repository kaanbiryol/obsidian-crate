import { PickerNativeControl } from './PickerNativeControl';

interface PickerTimeCardProps {
	label: string;
	detail?: string;
	controlIcon?: string;
	controlEmptyLabel?: string;
	hour?: number;
	minute?: number;
	onChange: (hour: number, minute: number) => void;
	onClear?: () => void;
}

export function PickerTimeCard({ label, detail, controlIcon, controlEmptyLabel, hour, minute, onChange, onClear }: PickerTimeCardProps) {
	const value = hour === undefined || minute === undefined
		? ''
		: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
	const input = (
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
			className={`picker-time-input${!controlIcon && value ? ' has-value' : ''}`}
		/>
	);

	return (
		<PickerFieldRow
			label={label}
			detail={detail}
			className="picker-time-card"
			asLabel
		>
			{controlIcon
				? <PickerNativeControl
					icon={controlIcon}
					hasValue={Boolean(value)}
					emptyLabel={controlEmptyLabel ?? label}
					>
						{value && <span className="picker-time-display" hidden aria-hidden="true">
							{new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
								.format(new Date(2000, 0, 1, hour, minute))}
						</span>}
						{input}
					</PickerNativeControl>
				: input}
		</PickerFieldRow>
	);
}
import { PickerFieldRow } from './PickerFieldRow';
