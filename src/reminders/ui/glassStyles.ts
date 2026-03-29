export interface GlassColors {
    backButton: {
        bg: string;
        border: string;
        hoverBg: string;
        shadow: string;
        hoverShadow: string;
    };
    surface: {
        bg: string;
        border: string;
    };
    surfaceHover: {
        bg: string;
        border: string;
    };
    text: {
        primary: string;
        secondary: string;
        tertiary: string;
    };
    accent: string;
    accentMuted: string;
}

export function getGlassColors(isDark: boolean): GlassColors {
    return {
        backButton: {
            bg: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)',
            border: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)',
            hoverBg: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)',
            shadow: `0 2px 8px ${isDark ? 'rgba(0, 0, 0, 0.12)' : 'rgba(0, 0, 0, 0.04)'}`,
            hoverShadow: `0 0 12px ${isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)'}`,
        },
        surface: {
            bg: isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.02)',
            border: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)',
        },
        surfaceHover: {
            bg: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
            border: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)',
        },
        text: {
            primary: 'var(--text-normal)',
            secondary: isDark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.45)',
            tertiary: isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.3)',
        },
        accent: 'hsl(var(--heroui-primary))',
        accentMuted: 'hsl(var(--heroui-primary) / 0.15)',
    };
}

export interface PickerModalBaseProps {
    variant: 'centered' | 'bottom-sheet';
    performanceMode: 'standard' | 'reduced-effects';
    showBackdrop: boolean;
    showDragHandle: boolean;
    zIndex: number;
}

export function getPickerModalProps(pickerMode: 'replace' | 'overlay'): PickerModalBaseProps {
    return {
        variant: pickerMode === 'overlay' ? 'centered' : 'bottom-sheet',
        performanceMode: pickerMode === 'overlay' ? 'standard' : 'reduced-effects',
        showBackdrop: false,
        showDragHandle: pickerMode !== 'overlay',
        zIndex: pickerMode === 'overlay' ? 70 : 60,
    };
}
