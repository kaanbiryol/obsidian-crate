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
