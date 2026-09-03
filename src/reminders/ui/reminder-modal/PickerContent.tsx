import type { PropsWithChildren } from 'react';

/**
 * Shared content rhythm for reminder picker dialogs.
 *
 * Modal headers and footers remain outside so scrolling and destructive actions
 * keep the same structure across Schedule and Repeat.
 */
export function PickerContent({ children }: PropsWithChildren) {
    return <div className="picker-content">{children}</div>;
}
