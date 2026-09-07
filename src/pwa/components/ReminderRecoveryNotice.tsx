import React from 'react';
import type { PendingReminderChange } from '../reminder-outbox-types';

export function ReminderRecoveryNotice({ changes, folderPath, onResume }: {
	changes: PendingReminderChange[];
	folderPath: string;
	onResume: () => void;
}) {
	if (!changes.length) return null;
	const exportChanges = () => {
		const blob = new Blob([JSON.stringify({ format: 'crate-reminder-recovery-v1', origin: window.location.origin,
			folderPath, changes }, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = 'crate-saved-changes.json';
		link.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
	};
	return <section className="pwa-reminder-sync-error" aria-label="Saved changes from an earlier session">
		<div className="pwa-reminder-sync-error__copy">
			<strong>Saved changes need your review</strong>
			<span role="status">{changes.length} {changes.length === 1 ? 'change was' : 'changes were'} kept when your earlier session ended. Resume to check what already synced and retry the rest.</span>
			<details><summary>Review saved changes</summary>{changes.map(change => <p key={change.operationId}>
				{change.optimistic?.content || change.previous?.content || change.modal?.draft.content || change.project || 'Reminder'}
				{change.modal?.draft.description ? ` — ${change.modal.draft.description}` : ''}
			</p>)}</details>
		</div>
		<div className="pwa-reminder-sync-error__actions">
			<button type="button" onClick={onResume}>Resume saved changes</button>
			<button type="button" onClick={exportChanges}>Export saved changes</button>
		</div>
	</section>;
}
