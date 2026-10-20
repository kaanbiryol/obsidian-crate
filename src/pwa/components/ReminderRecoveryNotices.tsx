import { lazy } from 'react';
import { DeferredNotice } from './DeferredNotice';
import type { PendingReminderChange } from '../reminders/outbox/reminder-outbox-types';
import type { QuarantinedReminderEntry } from '../reminders/outbox/reminder-outbox-storage';

const ReminderRecoveryNotice = lazy(() => import('./ReminderRecoveryNotice')
	.then(module => ({ default: module.ReminderRecoveryNotice })));
const ReminderQuarantineNotice = lazy(() => import('./ReminderQuarantineNotice')
	.then(module => ({ default: module.ReminderQuarantineNotice })));

/** Saved changes from earlier sessions and damaged entries, shown on the reminders screen and in feature settings. */
export function ReminderRecoveryNotices({ recoveryChanges, quarantinedChanges, folderPath, onResume, onRemove }: {
	recoveryChanges: PendingReminderChange[];
	quarantinedChanges: QuarantinedReminderEntry[];
	folderPath: string;
	onResume?: () => void;
	onRemove: (entries: QuarantinedReminderEntry[]) => Promise<boolean>;
}) {
	return <>
		{recoveryChanges.length > 0 && <DeferredNotice><ReminderRecoveryNotice changes={recoveryChanges} folderPath={folderPath} onResume={onResume} /></DeferredNotice>}
		{quarantinedChanges.length > 0 && <DeferredNotice><ReminderQuarantineNotice entries={quarantinedChanges} folderPath={folderPath} onRemove={onRemove} /></DeferredNotice>}
	</>;
}
