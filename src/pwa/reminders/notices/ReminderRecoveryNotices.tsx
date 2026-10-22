import type { PendingReminderChange } from '../outbox/reminder-outbox-types';
import type { QuarantinedReminderEntry } from '../outbox/reminder-outbox-storage';
import { ReminderRecoveryNotice } from './ReminderRecoveryNotice';
import { ReminderQuarantineNotice } from './ReminderQuarantineNotice';

/** Saved changes from earlier sessions and damaged entries, shown on the reminders screen and in feature settings. */
export function ReminderRecoveryNotices({ recoveryChanges, quarantinedChanges, folderPath, onResume, onRemove }: {
	recoveryChanges: PendingReminderChange[];
	quarantinedChanges: QuarantinedReminderEntry[];
	folderPath: string;
	onResume?: () => void;
	onRemove: (entries: QuarantinedReminderEntry[]) => Promise<boolean>;
}) {
	return <>
		{recoveryChanges.length > 0 && <ReminderRecoveryNotice changes={recoveryChanges} folderPath={folderPath} onResume={onResume} />}
		{quarantinedChanges.length > 0 && <ReminderQuarantineNotice entries={quarantinedChanges} folderPath={folderPath} onRemove={onRemove} />}
	</>;
}
