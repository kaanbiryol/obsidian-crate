import { addDays, isSameDay, nextMonday } from 'date-fns';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';

interface QuickDateOption {
	label: string;
	getDate: () => Date;
}

const QUICK_DATES: QuickDateOption[] = [
	{ label: 'Today', getDate: () => new Date() },
	{ label: 'Tomorrow', getDate: () => addDays(new Date(), 1) },
	{ label: 'Next week', getDate: () => nextMonday(new Date()) },
];

interface DateQuickButtonsProps {
	currentDate: Date | null;
	onSelectDate: (date: Date) => void;
}

export function DateQuickButtons({
	currentDate,
	onSelectDate,
}: DateQuickButtonsProps) {
	return (
		<div className="flex gap-2 px-4 pb-3">
			{QUICK_DATES.map(({ label, getDate }) => {
				const optionDate = getDate();
				const isActive = currentDate && isSameDay(currentDate, optionDate);
				return (
					<ShadowDOMNativeButton
						key={label}
						onClick={() => onSelectDate(optionDate)}
						className={`date-quick-button flex-1 h-9 rounded-xl active:scale-95${isActive ? ' is-active' : ''}`}
					>
						{label}
					</ShadowDOMNativeButton>
				);
			})}
		</div>
	);
}
