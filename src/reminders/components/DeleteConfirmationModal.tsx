import React, { useId } from 'react';
import { BaseModal } from './BaseModal';
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

    const handleConfirm = () => {
        onConfirm();
    };

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
                <header className="delete-confirmation-header">
                    <h2 id={titleId} className="delete-confirmation-title">{title}</h2>
                </header>
                <div className="delete-confirmation-body">
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
                        autoFocus={autoFocusCancel}
                        data-initial-focus={autoFocusCancel ? '' : undefined}
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
        </BaseModal>
    );

};
