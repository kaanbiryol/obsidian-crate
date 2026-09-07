import React, { useEffect, useId, useRef } from 'react';
import { BaseModal } from './BaseModal';
import { IconButton } from '../../ui/shared/IconButton';
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
    useNativeDialog?: boolean;
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
    useNativeDialog = false,
}) => {
    const titleId = useId();
    const messageId = useId();
    const dialogRef = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        if (!isOpen || !useNativeDialog) return;
        const dialog = dialogRef.current;
        dialog?.showModal();
        return () => dialog?.close();
    }, [isOpen, useNativeDialog]);

    const handleConfirm = () => {
        onConfirm();
    };

    if (!isOpen) return null;

    const content = (
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
            onKeyDown={(event) => {
                if (event.key !== 'Escape' || isLoading) return;
                event.stopPropagation();
                onClose();
            }}
        >
                <header className="delete-confirmation-header">
                    <h2 id={titleId} className="delete-confirmation-title">{title}</h2>
                    <IconButton
                        icon="x"
                        label="Close confirmation"
                        onClick={onClose}
                        disabled={isLoading}
                        className="delete-confirmation-close"
                    />
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
        </BaseModal>
    );

    return useNativeDialog ? (
        <dialog
            ref={dialogRef}
            className="delete-confirmation-dialog"
            aria-label={title}
            onCancel={(event) => {
                event.preventDefault();
                if (!isLoading) onClose();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            {content}
        </dialog>
    ) : content;
};
