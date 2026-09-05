import React from 'react';

import { ShadowDOMNativeButton } from './ShadowDOMNativeButton';
import { IconButton } from './IconButton';

interface ModalHeaderAction {
    label: string;
    onClick: () => void;
    ariaLabel?: string;
    disabled?: boolean;
}

interface ModalHeaderProps {
    title?: string;
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
            <IconButton
                icon="x"
                iconSize="m"
                onClick={onClose}
                label={closeLabel}
                title="Close"
                className="reminder-modal-header-close"
            />
        </div>

        <div className="reminder-modal-header-copy">
            {title && <h2 className="reminder-modal-header-title">{title}</h2>}
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
