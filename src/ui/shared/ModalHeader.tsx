import React from 'react';

import { Button } from './Button';
import { IconButton } from './IconButton';

interface ModalHeaderAction {
    label: string;
    onClick?: () => void;
    ariaLabel?: string;
    disabled?: boolean;
    type?: 'button' | 'submit';
    busy?: boolean;
    tone?: 'accent' | 'danger';
    dataAction?: string;
}

interface ModalHeaderProps {
    title?: string;
    closeLabel: string;
    onClose: () => void;
    action?: ModalHeaderAction;
    secondaryActions?: React.ReactNode;
    closeDisabled?: boolean;
    preventFocusOnPress?: boolean;
    titleLive?: 'polite';
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
    closeDisabled,
    preventFocusOnPress,
    titleLive,
}) => (
    <header className="reminder-modal-header">
        <div className="reminder-modal-header-side">
            <IconButton
                disabled={closeDisabled}
                preventFocusOnPress={preventFocusOnPress}
                icon="x"
                iconSize="m"
                onClick={onClose}
                label={closeLabel}
                title="Close"
                className="reminder-modal-header-close"
            />
        </div>

        <div className="reminder-modal-header-copy">
            {title && <h2 className="reminder-modal-header-title" aria-live={titleLive}>{title}</h2>}
        </div>

        <div className="reminder-modal-header-side is-right">
            {secondaryActions}
            {action && (
                <Button
                    onClick={action.onClick}
                    type={action.type}
                    aria-busy={action.busy}
                    data-action={action.dataAction}
                    data-tone={action.tone}
                    preventFocusOnPress={preventFocusOnPress}
                    disabled={action.disabled}
                    aria-label={action.ariaLabel ?? action.label}
                    className={`reminder-modal-header-action${action.disabled ? '' : ' is-enabled'}`}
                >
                    <span className="reminder-modal-header-action-label">{action.label}</span>
                </Button>
            )}
        </div>
    </header>
);
