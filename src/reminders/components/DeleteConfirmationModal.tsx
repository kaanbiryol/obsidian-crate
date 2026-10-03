import React, { useId } from 'react';
import { BaseModal } from './BaseModal';
import { Button } from '../../ui/shared/Button';
import { ModalLayout } from '../../ui/shared/ModalLayout';

interface DeleteConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    isLoading?: boolean;
    autoFocusCancel?: boolean;
}

/**
 * Theme-aware delete confirmation used in the reminders shadow root.
 */
export const DeleteConfirmationModal: React.FC<DeleteConfirmationModalProps> = ({
    isOpen,
    onClose,
    onConfirm,
    title = 'Delete reminder?',
    message = "Delete this reminder? This can't be undone.",
    confirmLabel = 'Delete',
    cancelLabel = 'Cancel',
    isLoading = false,
    autoFocusCancel = true,
}) => {
    const titleId = useId();
    const messageId = useId();

    if (!isOpen) return null;

    return (
        <BaseModal
            isOpen={isOpen}
            onClose={() => { if (!isLoading) onClose(); }}
            variant="centered"
            animationConfig={{ enabled: false }}
            showDragHandle={false}
            zIndex={100}
            className="delete-confirmation-surface"
            role="alertdialog"
            ariaLabelledBy={titleId}
            ariaDescribedBy={messageId}
            dismissible={!isLoading}
        >
            <ModalLayout title={title} titleId={titleId} onClose={onClose} closeDisabled={isLoading}
                footer={<div className="crate-modal-actions">
                    <Button variant="outline" onClick={onClose} disabled={isLoading}
                        autoFocus={autoFocusCancel} data-initial-focus={autoFocusCancel ? '' : undefined}>
                        {cancelLabel}
                    </Button>
                    <Button variant="primary" tone="danger" onClick={onConfirm} disabled={isLoading} aria-busy={isLoading}>
                        {confirmLabel}
                    </Button>
                </div>}>
                <p id={messageId} className="delete-confirmation-message">{message}</p>
            </ModalLayout>
        </BaseModal>
    );

};
