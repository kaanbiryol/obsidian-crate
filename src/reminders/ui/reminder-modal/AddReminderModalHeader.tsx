import React from 'react';
import { ArrowUp, Check, Trash2, X } from 'lucide-react';

import { ShadowDOMButton } from '../../components/ShadowDOMButton';

interface AddReminderModalHeaderProps {
    isEditing: boolean;
    canSubmit: boolean;
    onDelete: () => void;
    onClose: () => void;
    onSubmit: () => void;
    onTouchEnd?: () => void;
}

export const AddReminderModalHeader: React.FC<AddReminderModalHeaderProps> = ({
    isEditing,
    canSubmit,
    onDelete,
    onClose,
    onSubmit,
    onTouchEnd
}) => (
    <div
        className="flex justify-between items-center px-5 pt-3 pb-4"
        onTouchEnd={onTouchEnd}
    >
        {/* Left side - Delete (when editing) or Cancel */}
        <div className="w-16">
            {isEditing ? (
                <ShadowDOMButton
                    isIconOnly
                    size="sm"
                    color="danger"
                    variant="light"
                    onPress={onDelete}
                    className="reminder-header-delete min-w-9 w-9 h-9 rounded-xl"
                >
                    <Trash2 size={18} strokeWidth={2} />
                </ShadowDOMButton>
            ) : (
                <ShadowDOMButton
                    isIconOnly
                    size="sm"
                    variant="light"
                    onPress={onClose}
                    className="reminder-header-close min-w-9 w-9 h-9 rounded-xl"
                >
                    <X size={20} strokeWidth={2} />
                </ShadowDOMButton>
            )}
        </div>

        {/* Title (center) - Refined typography */}
        <div className="flex-1 text-center">
            <span className="reminder-header-title">
                {isEditing ? 'Edit Reminder' : 'New Reminder'}
            </span>
        </div>

        {/* Right side - Send button with subtle shadow (no glow) */}
        <div className="w-16 flex justify-end">
            <ShadowDOMButton
                isIconOnly
                size="sm"
                color="primary"
                onPress={canSubmit ? onSubmit : () => {}}
                className={`reminder-header-submit w-9 h-9 min-w-9 rounded-xl${canSubmit ? ' is-enabled' : ''}`}
                disableAnimation={!canSubmit}
            >
                {isEditing ? <Check size={18} strokeWidth={2.5} /> : <ArrowUp size={18} strokeWidth={2.5} />}
            </ShadowDOMButton>
        </div>
    </div>
);
