import { PwaButton as BaseButton } from './PwaButton';
import React from 'react';
import type { PendingReminderChange } from '../reminder-outbox-types';
import { ExpiredReminderChangeActions } from './ExpiredReminderChangeActions';
import { PwaNotice } from './PwaNotice';

function changeTitle(change: PendingReminderChange): string {
	return change.optimistic?.content || change.previous?.content || change.modal?.draft.content || change.project || 'Reminder';
}

function failureLabel(change: PendingReminderChange): string {
	if (change.reviewRequired) return 'Change needs review';
	if (change.status === 'uncertain') return 'Couldn’t sync';
	switch (change.kind) {
		case 'save': return 'Not saved';
		case 'complete': return 'Couldn’t update reminder';
		case 'delete': return 'Couldn’t delete reminder';
		case 'reorder': return 'Couldn’t reorder reminders';
	}
}

export function ReminderSyncNotice({
	changes,
	isOffline,
	onRetry,
	onEdit,
	onDiscard,
	storageError = null,
	onRetryInitialization,
}: {
	changes: PendingReminderChange[];
	isOffline: boolean;
	onRetry: (operationId: string) => void;
	onEdit: (operationId: string) => void;
	onDiscard: (operationId: string, reviewedChange?: string) => void;
	storageError?: string | null;
	onRetryInitialization?: () => void;
}) {
	const errors = changes.filter(change => change.status !== 'pending');
	if (!errors.length && !storageError) return null;

	return (
		<div className="pwa-reminder-sync-notices" aria-label="Reminder sync">
			{storageError && (
				<PwaNotice title="Couldn’t load pending changes" aria-label="Pending changes unavailable"
					actions={onRetryInitialization &&
						<BaseButton variant="ghost" size="touch" type="button" onClick={onRetryInitialization} aria-label="Retry loading pending changes">Retry</BaseButton>
					}>
					<span role="status">{storageError}</span>
				</PwaNotice>
			)}
			{errors.map(change => {
				const title = changeTitle(change);
				const failedSave = change.status === 'failed' && !change.ambiguous && change.kind === 'save';
				const description = failedSave ? change.modal?.draft.description ?? change.optimistic?.description : undefined;
				return (
					<PwaNotice
						key={change.operationId}
						title={failureLabel(change)}
						aria-label={`${failureLabel(change)}: ${title}`}
						data-sync-status={change.status}
						actions={change.reviewRequired ? <ExpiredReminderChangeActions change={change} onDiscard={onDiscard} /> : <>
							<BaseButton variant="ghost" size="touch" type="button" onClick={() => onRetry(change.operationId)} disabled={isOffline} aria-label={`Retry: ${title}`}>Retry</BaseButton>
							{failedSave && <BaseButton variant="ghost" size="touch" type="button" onClick={() => onEdit(change.operationId)} disabled={isOffline} aria-label={`Edit: ${title}`}>Edit</BaseButton>}
							{change.status === 'failed' && (
								<BaseButton variant="ghost" size="touch" type="button" onClick={() => onDiscard(change.operationId)} aria-label={`${failedSave ? 'Discard' : 'Dismiss'}: ${title}`}>
									{failedSave ? 'Discard' : 'Dismiss'}
								</BaseButton>
							)}
						</>}>
						<span className="pwa-reminder-change-title">{title}</span>
						{description && <details><summary>Draft details</summary><p>{description}</p></details>}
						<span role="status">{change.error || (change.status === 'uncertain'
							? 'Your change is kept on this device. Retry to confirm it synced.'
							: 'Your change could not be saved.')}</span>
					</PwaNotice>
				);
			})}
		</div>
	);
}
