import { downloadJson } from '../download';
import { PwaButton } from './PwaButton';
import { PwaNotice } from './PwaNotice';
import React from 'react';
import type { PendingReminderChange } from '../reminder-outbox-types';

export function ReminderRecoveryNotice({ changes, folderPath, onResume }: {
	changes: PendingReminderChange[];
	folderPath: string;
	onResume: () => void;
}) {
	if (!changes.length) return null;
	const exportChanges = () => {
		downloadJson('crate-saved-changes.json', { format: 'crate-reminder-recovery-v1', origin: window.location.origin, folderPath, changes });
	};
	return <PwaNotice title="Saved changes need your review" aria-label="Saved changes from an earlier session" actions={<>
		<PwaButton variant="ghost" size="touch" onClick={onResume}>Resume saved changes</PwaButton>
		<PwaButton variant="ghost" size="touch" onClick={exportChanges}>Export saved changes</PwaButton>
	</>}>
		<span role="status">{changes.length} {changes.length === 1 ? 'change was' : 'changes were'} kept when your earlier session ended. Resume to check what already synced and retry the rest.</span>
		<details><summary>Review saved changes</summary>{changes.map(change => <p key={change.operationId}>
			{change.optimistic?.content || change.previous?.content || change.modal?.draft.content || change.project || 'Reminder'}
			{change.modal?.draft.description ? ` — ${change.modal.draft.description}` : ''}
		</p>)}</details>
	</PwaNotice>;
}
