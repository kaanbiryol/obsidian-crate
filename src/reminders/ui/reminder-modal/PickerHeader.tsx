import React from 'react';

import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { ObsidianIcon } from '../../components/obsidian-icon';

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
        <div className="picker-header">
            <ShadowDOMNativeButton
                onClick={onBack}
                aria-label={closeLabel}
                className="picker-header-button"
            >
                <ObsidianIcon size="m" id="x" />
            </ShadowDOMNativeButton>

            <div className="picker-header-copy">
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
                <div className="picker-header-spacer" />
            )}
        </div>
    );
};
