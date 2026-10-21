import type { PropsWithChildren } from 'react';

/**
 * Shared content rhythm for reminder picker dialogs.
 *
 * Individual pickers can include lightweight command rows when those actions
 * belong to the main content flow.
 */
export function PickerContent({ children }: PropsWithChildren) {
    return <div className="picker-content">{children}</div>;
}
