import React from 'react';
import { ModalHeader } from '@/ui/shared/ModalHeader';
import { useDialogFocus } from '../hooks/useDialogFocus';

/** Confirmation content for the dedicated delete screen in the reminder sheet. */
export function PwaDeleteConfirmation({ id, message, isLoading, onClose, onConfirm }: {
	id: string;
	message: string;
	isLoading: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	const { setDialogRef, handleDialogKeyDown } = useDialogFocus({
		activeKey: id, restoreFocus: false, escapeDisabled: isLoading, onEscape: onClose,
	});
	return (
		<section id={id} ref={setDialogRef} className="pwa-delete-confirmation" role="alertdialog"
			aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`}
			aria-busy={isLoading} tabIndex={-1} onKeyDown={handleDialogKeyDown}>
			<ModalHeader title="Delete reminder" titleId={`${id}-title`} closeLabel="Cancel deletion"
				onClose={onClose} closeDisabled={isLoading} preventFocusOnPress />
			<div className="pwa-delete-confirmation-body">
				<p id={`${id}-message`}>{message}</p>
				<div className="pwa-delete-confirmation-actions">
					<button type="button" disabled={isLoading} onClick={onClose}>Cancel</button>
					<button type="button" className="is-destructive" disabled={isLoading} onClick={onConfirm}>
						{isLoading ? 'Deleting…' : 'Delete reminder'}
					</button>
				</div>
			</div>
		</section>
	);
}
