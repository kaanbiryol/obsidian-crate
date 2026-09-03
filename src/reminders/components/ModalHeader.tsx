import React from 'react';

import { ObsidianIcon } from './obsidian-icon';
import { ShadowDOMNativeButton } from './ShadowDOMNativeButton';

export interface ModalHeaderAction {
    label: string;
    onClick: () => void;
    ariaLabel?: string;
    disabled?: boolean;
}

interface ModalHeaderProps {
    title: string;
    closeLabel: string;
    onClose: () => void;
    action?: ModalHeaderAction;
    secondaryActions?: React.ReactNode;
}

/**
 * Shared chrome for reminder editor and picker dialogs.
 *
 * Screens own their actions; this component owns the repeated structure,
 * accessibility, and visual hierarchy of the header itself.
 */
export const ModalHeader: React.FC<ModalHeaderProps> = ({
    title,
    closeLabel,
    onClose,
    action,
    secondaryActions,
}) => (
    <header className="reminder-modal-header">
        <div className="reminder-modal-header-side">
            <ShadowDOMNativeButton
                onClick={onClose}
                aria-label={closeLabel}
                title="Close"
                className="reminder-modal-header-close"
            >
                <ObsidianIcon size="m" id="x" />
            </ShadowDOMNativeButton>
        </div>

        <div className="reminder-modal-header-copy">
            <h2 className="reminder-modal-header-title">{title}</h2>
        </div>

        <div className="reminder-modal-header-side is-right">
            {secondaryActions}
            {action && (
                <ShadowDOMNativeButton
                    onClick={action.onClick}
                    disabled={action.disabled}
                    aria-label={action.ariaLabel ?? action.label}
                    className={`reminder-modal-header-action${action.disabled ? '' : ' is-enabled'}`}
                >
                    {action.label}
                </ShadowDOMNativeButton>
            )}
        </div>
    </header>
);
