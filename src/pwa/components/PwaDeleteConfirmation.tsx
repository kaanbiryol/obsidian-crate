import { Button as BaseButton } from '@base-ui/react/button';
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
				<div className="pwa-delete-confirmation-actions">
					<BaseButton type="button" disabled={isLoading} onClick={onClose}>Cancel</BaseButton>
					<BaseButton type="button" className="is-destructive" disabled={isLoading} onClick={onConfirm}>
						{isLoading ? 'Deleting…' : 'Delete reminder'}
					</BaseButton>
				</div>
			</div>
		</section>
	);
}
