import { isSameDay } from 'date-fns';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { ObsidianIcon } from '../../components/obsidian-icon';
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
		hour: 'numeric',
		minute: '2-digit',
	});
	const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

	return (
		<div className="date-quick-options">
			{REMINDER_DATE_PRESETS.map(({ id, label }) => {
				const optionDate = getReminderDateForPreset(id, now);
				const isActive = Boolean(
					currentDate
					&& isSameDay(currentDate, optionDate)
					&& (id === 'evening'
						? hasTime && currentDate.getHours() === 18 && currentDate.getMinutes() === 0
						: !hasTime),
				);
				const detail = id === 'evening'
					? `${weekdayFormatter.format(optionDate)}, ${timeFormatter.format(optionDate)}`
					: dateFormatter.format(optionDate);
				return (
					<ShadowDOMNativeButton
						key={id}
						onClick={() => onSelectPreset(id)}
						aria-pressed={isActive}
						className={`date-quick-button${isActive ? ' is-active' : ''}`}
					>
						<span className="date-quick-button-copy">
							<strong>{label}</strong>
							<small>{detail}</small>
						</span>
						{isActive && (
							<ObsidianIcon size="s" id="check" className="date-quick-button-check" aria-hidden="true" />
						)}
					</ShadowDOMNativeButton>
				);
			})}
		</div>
	);
}
