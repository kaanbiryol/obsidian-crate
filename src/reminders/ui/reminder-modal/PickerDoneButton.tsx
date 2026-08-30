import React from 'react';

import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';

interface PickerDoneButtonProps {
    onClick: () => void;
    label?: string;
    removeAction?: {
        label: string;
        onClick: () => void;
    };
}

export const PickerDoneButton: React.FC<PickerDoneButtonProps> = ({
    onClick,
    label = 'Done',
    removeAction,
}) => {
    return (
        <div className="picker-footer px-4 pt-4 pb-2">
            {removeAction && (
                <ShadowDOMNativeButton
                    onClick={removeAction.onClick}
                    className="picker-remove-button w-full h-9 rounded-xl active:scale-[0.98]"
                >
                    {removeAction.label}
                </ShadowDOMNativeButton>
            )}
            <ShadowDOMNativeButton
                onClick={onClick}
                className="picker-done-button w-full h-12 rounded-2xl active:scale-[0.98]"
            >
                {label}
            </ShadowDOMNativeButton>
        </div>
    );
};
