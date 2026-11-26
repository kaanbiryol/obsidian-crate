import { ThemeIcon } from '../../../ui/shared/ThemeIcon';
import { formatCompletedAt } from '../format/dateFormatting';

/** When an opened reminder was completed, shown read-only under the editor's chips. */
export function ReminderCompletedNote({ completedAt }: { completedAt?: string }) {
	const label = completedAt ? formatCompletedAt(completedAt, undefined, new Date(), true) : null;
	if (!label) return null;
	return (
		<div className="reminder-completed-note">
			<ThemeIcon size="xs" id="circle-check" aria-hidden="true" />
			<span>Completed {label}</span>
		</div>
	);
}
