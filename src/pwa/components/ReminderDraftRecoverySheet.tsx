import React, { useState } from 'react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { discardReviewedReminderDraft, type inspectReminderDraft } from '../reminder-drafts';
import { ReminderQuarantineNotice } from './ReminderQuarantineNotice';
import { PwaModalSheet } from './PwaModalSheet';
import type { ModalState } from '../types';

export function ReminderDraftRecoverySheet({ inspection, initial, folderPath, isClosing, onClose, onClosed, onRetry }: {
	inspection: ReturnType<typeof inspectReminderDraft>;
	initial: ModalState;
	folderPath: string;
	isClosing: boolean;
	onClose: () => void;
	onClosed: () => void;
	onRetry: () => void;
}) {
	const [error, setError] = useState<string | null>(null);
	const { handleDialogKeyDown, setDialogRef } = useDialogFocus({ activeKey: 'draft-recovery', onEscape: onClose });
	return <PwaModalSheet isOpen={!isClosing} onClose={onClose} onCloseEnd={onClosed} variant="settings" detent="content" onKeyDown={handleDialogKeyDown}>
		<div className="modal-card" role="dialog" aria-modal="true" aria-label="Saved draft needs review" ref={setDialogRef} tabIndex={-1}>
			{inspection.recovery ? <ReminderQuarantineNotice kind="draft" entries={[inspection.recovery]} folderPath={folderPath} onRemove={entries => {
				try {
					const entry = entries[0];
					if (!entry) return Promise.resolve(false);
					discardReviewedReminderDraft(entry, initial, folderPath);
					onRetry();
					return Promise.resolve(true);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : 'The saved draft could not be removed. Try again.');
					return Promise.resolve(false);
				}
			}} /> : <><p role="status">Saved drafts could not be read. Restore access to browser storage and try again.</p><button className="secondary-button" type="button" onClick={onRetry}>Try again</button></>}
			{error && <p role="alert">{error}</p>}
			<button className="secondary-button" type="button" onClick={onClose}>Close</button>
		</div>
	</PwaModalSheet>;
}
