import React from 'react';
import { ChevronLeft } from 'lucide-react';

import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';

interface PickerHeaderProps {
    onBack: () => void;
    title: string;
    subtitle?: string;
}

export const PickerHeader: React.FC<PickerHeaderProps> = ({
    onBack,
    title,
    subtitle,
}) => {
    return (
        <div className="flex items-center justify-between px-5 pt-2 pb-3">
            <ShadowDOMNativeButton
                onClick={onBack}
                className="picker-header-button flex items-center justify-center w-11 h-11 rounded-xl active:scale-95"
            >
                <ChevronLeft size={20} strokeWidth={2} />
            </ShadowDOMNativeButton>

            <div className="flex flex-col items-center">
                <span className="picker-header-title">
                    {title}
                </span>
                {subtitle && (
                    <span className="picker-header-subtitle">
                        {subtitle}
                    </span>
                )}
            </div>

            <div className="w-11" />
        </div>
    );
};
