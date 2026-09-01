import React from 'react';
import { X } from 'lucide-react';

import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';

interface PickerHeaderProps {
    onBack: () => void;
    closeLabel: string;
    title: string;
    actionLabel?: string;
    onAction?: () => void;
}

export const PickerHeader: React.FC<PickerHeaderProps> = ({
    onBack,
    closeLabel,
    title,
    actionLabel,
    onAction,
}) => {
    return (
        <div className="picker-header flex items-center justify-between px-5 pt-2 pb-3">
            <ShadowDOMNativeButton
                onClick={onBack}
                aria-label={closeLabel}
                className="picker-header-button flex items-center justify-center w-11 h-11 rounded-xl active:scale-95"
            >
                <X size={18} strokeWidth={2} />
            </ShadowDOMNativeButton>

            <div className="picker-header-copy flex flex-col items-center">
                <span className="picker-header-title">
                    {title}
                </span>
            </div>

            {actionLabel && onAction ? (
                <ShadowDOMNativeButton
                    onClick={onAction}
                    className="picker-header-action"
                >
                    {actionLabel}
                </ShadowDOMNativeButton>
            ) : (
                <div className="picker-header-spacer w-11" />
            )}
        </div>
    );
};
