import React from 'react';
import { ArrowUp, Check, Trash2, X } from 'lucide-react';

import { ShadowDOMButton } from '../ShadowDOMButton';

interface AddReminderModalHeaderProps {
    isEditing: boolean;
    isDark: boolean;
    textColor: string;
    canSubmit: boolean;
    onDelete: () => void;
    onClose: () => void;
    onSubmit: () => void;
    onTouchEnd?: () => void;
}

export const AddReminderModalHeader: React.FC<AddReminderModalHeaderProps> = ({
    isEditing,
    isDark,
    textColor,
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
                    className="min-w-9 w-9 h-9 rounded-xl"
                    style={{
                        backgroundColor: 'rgba(239, 68, 68, 0.08)',
                        border: '1px solid rgba(239, 68, 68, 0.12)',
                        color: 'rgba(239, 68, 68, 0.9)',
                        transition: 'all 0.35s ease-out',
                    }}
                >
                    <Trash2 size={18} strokeWidth={2} />
                </ShadowDOMButton>
            ) : (
                <ShadowDOMButton
                    isIconOnly
                    size="sm"
                    variant="light"
                    onPress={onClose}
                    className="min-w-9 w-9 h-9 rounded-xl"
                    style={{
                        backgroundColor: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)',
                        border: isDark ? '1px solid rgba(255, 255, 255, 0.06)' : '1px solid rgba(0, 0, 0, 0.04)',
                        color: isDark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.4)',
                        transition: 'all 0.35s ease-out',
                    }}
                >
                    <X size={20} strokeWidth={2} />
                </ShadowDOMButton>
            )}
        </div>

        {/* Title (center) - Refined typography */}
        <div className="flex-1 text-center">
            <span
                style={{
                    fontSize: '20px',
                    fontWeight: 600,
                    color: textColor,
                    letterSpacing: '-0.025em',
                }}
            >
                {isEditing ? 'Edit Reminder' : 'New Reminder'}
            </span>
        </div>

        {/* Right side - Send button with subtle shadow (no glow) */}
        <div className="w-16 flex justify-end">
            <ShadowDOMButton
                isIconOnly
                size="sm"
                color="primary"
                onPress={onSubmit}
                isDisabled={!canSubmit}
                className="w-9 h-9 min-w-9 rounded-xl"
                style={canSubmit ? {
                    background: 'hsl(var(--heroui-primary))',
                    boxShadow: '0 2px 8px hsl(var(--heroui-primary) / 0.2)',
                    color: 'white',
                    transition: 'all 0.35s ease-out',
                } : {
                    backgroundColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
                    color: isDark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.2)',
                    transition: 'all 0.35s ease-out',
                }}
            >
                {isEditing ? <Check size={18} strokeWidth={2.5} /> : <ArrowUp size={18} strokeWidth={2.5} />}
            </ShadowDOMButton>
        </div>
    </div>
);
