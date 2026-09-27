import { downloadJson } from './download';
import type { PendingReminderChange } from './reminder-outbox-types';

/** Review copy only; importing it must never silently mint fresh operation IDs. */
export function exportPendingChanges(changes: PendingReminderChange[]): void {
	downloadJson('crate-pending-changes.json', { format: 'crate-pending-reminder-changes-v1', origin: location.origin, changes });
}
