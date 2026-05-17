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
                className="w-full h-12 rounded-2xl transition-all duration-200 active:scale-[0.98]"
                style={{
                    fontSize: '15px',
                    fontWeight: 600,
                    letterSpacing: '-0.01em',
                    background: 'hsl(var(--heroui-primary))',
                    color: 'white',
                    border: 'none',
                    cursor: 'pointer',
                    boxShadow: '0 2px 6px hsl(var(--heroui-primary) / 0.15)',
                    transition: 'all 200ms ease-out',
                }}
            >
                {label}
            </ShadowDOMNativeButton>
        </div>
    );
};
