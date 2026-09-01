import React from 'react';

import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { ObsidianIcon } from '../../components/obsidian-icon';

interface PickerDoneButtonProps {
    onClick?: () => void;
    label?: string;
    showPrimary?: boolean;
    removeAction?: {
        label: string;
        onClick: () => void;
    };
}

export const PickerDoneButton: React.FC<PickerDoneButtonProps> = ({
    onClick,
    label = 'Done',
    showPrimary = true,
    removeAction,
}) => {
    return (
        <div className="picker-footer px-4 pt-4 pb-2">
            {removeAction && (
                <ShadowDOMNativeButton
                    onClick={removeAction.onClick}
                    className="picker-remove-button"
                >
                    <ObsidianIcon size="s" id="x" aria-hidden="true" />
                    {removeAction.label}
                </ShadowDOMNativeButton>
            )}
            {showPrimary && onClick && (
                <ShadowDOMNativeButton
                    onClick={onClick}
                    className="picker-done-button"
                >
                    {label}
                </ShadowDOMNativeButton>
            )}
        </div>
    );
};
