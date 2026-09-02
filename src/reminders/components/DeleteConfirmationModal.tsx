import React, { useId } from 'react';
import { ShadowDOMButton } from './ShadowDOMButton';

interface DeleteConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    isLoading?: boolean;
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
    isLoading = false
}) => {
    const titleId = useId();
    const messageId = useId();

    const handleConfirm = () => {
        onConfirm();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div
                className="modal-backdrop is-interactive absolute inset-0"
                onClick={onClose}
            />

            <div
                className="delete-confirmation-surface relative w-full"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={messageId}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                    if (event.key !== 'Escape' || isLoading) return;
                    event.stopPropagation();
                    onClose();
                }}
            >
                <div className="delete-confirmation-copy">
                    <h3 id={titleId} className="delete-confirmation-title">
                        {title}
                    </h3>
                    <p id={messageId} className="delete-confirmation-message">
                        {message}
                    </p>
                </div>

                <div className="delete-confirmation-actions">
                    <ShadowDOMButton
                        size="sm"
                        variant="flat"
                        onPress={onClose}
                        className="delete-confirmation-button delete-confirmation-cancel"
                        isDisabled={isLoading}
                        autoFocus
                    >
                        {cancelLabel}
                    </ShadowDOMButton>
                    <ShadowDOMButton
                        size="sm"
                        color="danger"
                        onPress={handleConfirm}
                        className="delete-confirmation-button delete-confirmation-confirm"
                        isLoading={isLoading}
                    >
                        {confirmLabel}
                    </ShadowDOMButton>
                </div>
            </div>
        </div>
    );
};
