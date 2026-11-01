import { isSameDay } from 'date-fns';
import { ToggleButton } from '../../../ui/shared/ToggleButton';
import { ThemeIcon } from '../../../ui/shared/ThemeIcon';
import {
	getReminderDateForPreset,
	REMINDER_DATE_PRESETS,
	type ReminderDatePreset,
} from './datePresets';

interface DateQuickButtonsProps {
	currentDate: Date | null;
	hasTime: boolean;
	onSelectPreset: (preset: ReminderDatePreset) => void;
}

const PRESET_ICONS: Record<ReminderDatePreset, string> = {
	today: 'sun',
	tomorrow: 'sunrise',
	evening: 'sunset',
	'next-week': 'calendar-plus',
};

export function DateQuickButtons({
	currentDate,
	hasTime,
	onSelectPreset,
}: DateQuickButtonsProps) {
	const now = new Date();
	const dateFormatter = new Intl.DateTimeFormat(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
	const timeFormatter = new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit', hourCycle: 'h23',
	});
	const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

	return (
		<div className="date-quick-options">
			{REMINDER_DATE_PRESETS.map(({ id, label, hasTime: presetHasTime }) => {
				const optionDate = getReminderDateForPreset(id, now);
				const isActive = Boolean(
					currentDate
					&& isSameDay(currentDate, optionDate)
					&& (presetHasTime
						? hasTime && currentDate.getHours() === optionDate.getHours() && currentDate.getMinutes() === optionDate.getMinutes()
						: !hasTime),
				);
				const detail = presetHasTime
					? `${weekdayFormatter.format(optionDate)}, ${timeFormatter.format(optionDate)}`
					: dateFormatter.format(optionDate);
				return (
					<ToggleButton
						key={id}
						onPressedChange={() => onSelectPreset(id)}
						pressed={isActive}
						className={`date-quick-button${isActive ? ' is-active' : ''}`}
					>
						<ThemeIcon
							size="s"
							id={isActive ? 'check' : PRESET_ICONS[id]}
							className={isActive ? 'date-quick-button-check' : 'date-quick-button-icon'}
							aria-hidden="true"
						/>
						<span className="date-quick-button-copy">
							<strong>{label}</strong>
							<small>{detail}</small>
						</span>
					</ToggleButton>
				);
			})}
		</div>
	);
}
