import React from 'react';
import { Trash2, X } from 'lucide-react';

import { ShadowDOMButton } from '../../components/ShadowDOMButton';

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
    <div className="flex justify-between items-center px-5 pt-3 pb-4">
        {/* Left side - Delete (when editing) or Cancel */}
        <div className="w-16">
            {isEditing ? (
                <ShadowDOMButton
                    isIconOnly
                    size="sm"
                    color="danger"
                    variant="light"
                    onPress={onDelete}
                    aria-label="Delete reminder"
                    className="reminder-header-delete min-w-8 w-8 h-8 rounded-full"
                >
                    <Trash2 size={16} strokeWidth={2} />
                </ShadowDOMButton>
            ) : (
                <ShadowDOMButton
                    isIconOnly
                    size="sm"
                    variant="light"
                    onPress={onClose}
                    aria-label="Close reminder editor"
                    className="reminder-header-close min-w-8 w-8 h-8 rounded-full"
                >
                    <X size={18} strokeWidth={2} />
                </ShadowDOMButton>
            )}
        </div>

        {/* Title (center) - Refined typography */}
        <div className="flex-1 text-center">
            <span className="reminder-header-title">
                {isEditing ? 'Edit reminder' : 'New reminder'}
            </span>
        </div>

        {/* Right side - explicit text keeps the primary action unambiguous */}
        <div className="w-16 flex justify-end">
            <ShadowDOMButton
                size="sm"
                variant="light"
                onPress={onSubmit}
                isDisabled={!canSubmit}
                aria-label={isEditing ? 'Save reminder' : 'Add reminder'}
                className={`reminder-header-submit h-9 min-w-0 rounded-lg${canSubmit ? ' is-enabled' : ''}`}
                disableAnimation={!canSubmit}
            >
                {isEditing ? 'Save' : 'Add'}
            </ShadowDOMButton>
        </div>
    </div>
);
