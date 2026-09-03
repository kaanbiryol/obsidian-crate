import React from 'react';

import { ModalHeader } from '../../components/ModalHeader';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { ObsidianIcon } from '../../components/obsidian-icon';

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
            <ShadowDOMNativeButton
                onClick={onDelete}
                aria-label="Delete reminder"
                className="reminder-modal-header-icon reminder-header-delete"
            >
                <ObsidianIcon size="m" id="trash-2" />
            </ShadowDOMNativeButton>
        ) : undefined}
        action={{
            label: isEditing ? 'Save' : 'Add',
            ariaLabel: isEditing ? 'Save reminder' : 'Add reminder',
            onClick: onSubmit,
            disabled: !canSubmit,
        }}
    />
);
