import React from 'react';

import { ShadowDOMNativeButton } from '../../components/ShadowDOMButton';

interface PickerDoneButtonProps {
    onClick: () => void;
    label?: string;
}

export const PickerDoneButton: React.FC<PickerDoneButtonProps> = ({
    onClick,
    label = 'Done',
}) => {
    return (
        <div className="px-4 pt-4 pb-2">
            <ShadowDOMNativeButton
                onClick={onClick}
                className="picker-done-button w-full h-12 rounded-2xl active:scale-[0.98]"
            >
                {label}
            </ShadowDOMNativeButton>
        </div>
    );
};
