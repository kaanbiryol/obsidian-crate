import React from 'react';

import { IconButton } from '../../components/IconButton';
import { ModalHeader } from '../../components/ModalHeader';

interface AddReminderModalHeaderProps {
    isEditing: boolean;
    canSubmit: boolean;
    onDelete: () => void;
    onClose: () => void;
    onSubmit: () => void;
}

export const AddReminderModalHeader: React.FC<AddReminderModalHeaderProps> = ({
    isEditing,
    canSubmit,
    onDelete,
    onClose,
    onSubmit
}) => (
    <ModalHeader
        title={isEditing ? 'Edit reminder' : 'New reminder'}
        closeLabel="Close reminder editor"
        onClose={onClose}
        secondaryActions={isEditing ? (
            <IconButton
                icon="trash-2"
                iconSize="m"
                onClick={onDelete}
                label="Delete reminder"
                tone="danger"
                className="reminder-modal-header-icon reminder-header-delete"
            />
        ) : undefined}
        action={{
            label: isEditing ? 'Save' : 'Add',
            ariaLabel: isEditing ? 'Save reminder' : 'Add reminder',
            onClick: onSubmit,
            disabled: !canSubmit,
        }}
    />
);
