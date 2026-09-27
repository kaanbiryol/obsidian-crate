import { PwaButton } from './PwaButton';
import React from 'react';
import { ModalHeader } from '@/ui/shared/ModalHeader';

/** Confirmation content for the dedicated delete screen in the reminder sheet. */
export function PwaDeleteConfirmation({ id, message, isLoading, onClose, onConfirm }: {
	id: string;
	message: string;
	isLoading: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	return (
		<section id={id} className="pwa-delete-confirmation"
			aria-busy={isLoading} tabIndex={-1}>
			<ModalHeader title="Delete reminder" titleId={`${id}-title`} closeLabel="Cancel deletion"
				onClose={onClose} closeDisabled={isLoading} preventFocusOnPress />
			<div className="pwa-delete-confirmation-body">
				<p id={`${id}-message`}>{message}</p>
				<div className="crate-dialog-actions pwa-delete-confirmation-actions">
					<PwaButton size="touch" disabled={isLoading} onClick={onClose}>Cancel</PwaButton>
					<PwaButton variant="primary" tone="danger" size="touch" disabled={isLoading} onClick={onConfirm}>
						{isLoading ? 'Deleting…' : 'Delete reminder'}
					</PwaButton>
				</div>
			</div>
		</section>
	);
}
