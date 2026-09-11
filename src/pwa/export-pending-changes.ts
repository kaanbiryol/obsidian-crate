import type { PendingReminderChange } from './reminder-outbox-types';

/** Review copy only; importing it must never silently mint fresh operation IDs. */
export function exportPendingChanges(changes: PendingReminderChange[]): void {
	const blob = new Blob([JSON.stringify({ format: 'crate-pending-reminder-changes-v1', origin: location.origin, changes }, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = 'crate-pending-changes.json';
	link.click();
	window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
