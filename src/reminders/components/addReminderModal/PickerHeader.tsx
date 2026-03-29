import React from 'react';
import { ChevronLeft } from 'lucide-react';

import { ShadowDOMNativeButton } from '../ShadowDOMButton';
import { getGlassColors } from '../../ui/glassStyles';

interface PickerHeaderProps {
    onBack: () => void;
    isDark: boolean;
    title: string;
    subtitle?: string;
}

export const PickerHeader: React.FC<PickerHeaderProps> = ({
    onBack,
    isDark,
    title,
    subtitle,
}) => {
    const glass = getGlassColors(isDark);

    return (
        <div className="flex items-center justify-between px-5 pt-2 pb-3">
            <ShadowDOMNativeButton
                onClick={onBack}
                className="flex items-center justify-center w-11 h-11 rounded-xl transition-all duration-200 active:scale-95"
                style={{
                    background: glass.backButton.bg,
                    border: `1px solid ${glass.backButton.border}`,
                    color: 'var(--text-muted)',
                    boxShadow: glass.backButton.shadow,
                    transition: 'transform 200ms ease-out',
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                    e.currentTarget.style.background = glass.backButton.hoverBg;
                    e.currentTarget.style.boxShadow = glass.backButton.hoverShadow;
                }}
                onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                    e.currentTarget.style.background = glass.backButton.bg;
                    e.currentTarget.style.boxShadow = glass.backButton.shadow;
                }}
            >
                <ChevronLeft size={20} strokeWidth={2} />
            </ShadowDOMNativeButton>

            <div className="flex flex-col items-center">
                <span
                    style={{
                        fontSize: '20px',
                        fontWeight: 700,
                        color: 'var(--text-normal)',
                        letterSpacing: '-0.02em',
                    }}
                >
                    {title}
                </span>
                {subtitle && (
                    <span
                        style={{
                            fontSize: '13px',
                            fontWeight: 500,
                            color: 'var(--text-muted)',
                            marginTop: '2px',
                            opacity: 0.85,
                        }}
                    >
                        {subtitle}
                    </span>
                )}
            </div>

            <div className="w-11" />
        </div>
    );
};
