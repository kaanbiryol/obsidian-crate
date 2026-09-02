import React from 'react';

import { ShadowDOMButton } from '../../components/ShadowDOMButton';
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
    <div className="reminder-editor-header">
        {/* Left side - Delete (when editing) or Cancel */}
        <div className="reminder-editor-header-side">
            {isEditing ? (
                <ShadowDOMButton
                    isIconOnly
                    size="sm"
                    color="danger"
                    variant="light"
                    onPress={onDelete}
                    aria-label="Delete reminder"
                    className="reminder-header-icon reminder-header-delete"
                >
                    <ObsidianIcon size="m" id="trash-2" />
                </ShadowDOMButton>
            ) : (
                <ShadowDOMNativeButton
                    onClick={onClose}
                    aria-label="Close reminder editor"
                    className="picker-header-button"
                >
                    <ObsidianIcon size="m" id="x" />
                </ShadowDOMNativeButton>
            )}
        </div>

        {/* Title (center) - Refined typography */}
        <div className="reminder-editor-header-copy">
            <h2 className="reminder-header-title">
                {isEditing ? 'Edit reminder' : 'New reminder'}
            </h2>
        </div>

        {/* Right side - explicit text keeps the primary action unambiguous */}
        <div className="reminder-editor-header-side is-right">
            <ShadowDOMButton
                size="sm"
                variant="light"
                onPress={onSubmit}
                isDisabled={!canSubmit}
                aria-label={isEditing ? 'Save reminder' : 'Add reminder'}
                className={`reminder-header-submit${canSubmit ? ' is-enabled' : ''}`}
                disableAnimation={!canSubmit}
            >
                {isEditing ? 'Save' : 'Add'}
            </ShadowDOMButton>
        </div>
    </div>
);
