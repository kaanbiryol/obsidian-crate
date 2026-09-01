import React from 'react';

import { ShadowDOMButton } from '../../components/ShadowDOMButton';
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
    <div className="reminder-editor-header flex justify-between items-center px-5 pt-3 pb-4">
        {/* Left side - Delete (when editing) or Cancel */}
        <div className="reminder-editor-header-side w-16">
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
                    <ObsidianIcon size="s" id="trash-2" />
                </ShadowDOMButton>
            ) : (
                <ShadowDOMButton
                    isIconOnly
                    size="sm"
                    variant="light"
                    onPress={onClose}
                    aria-label="Close reminder editor"
                    className="reminder-header-icon reminder-header-close"
                >
                    <ObsidianIcon size="m" id="x" />
                </ShadowDOMButton>
            )}
        </div>

        {/* Title (center) - Refined typography */}
        <div className="reminder-editor-header-copy flex-1 text-center">
            <h2 className="reminder-header-title">
                {isEditing ? 'Edit reminder' : 'New reminder'}
            </h2>
        </div>

        {/* Right side - explicit text keeps the primary action unambiguous */}
        <div className="reminder-editor-header-side is-right w-16 flex justify-end">
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
