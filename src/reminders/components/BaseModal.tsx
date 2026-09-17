import React, { useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Drawer } from '@base-ui/react/drawer';
import type { AnimationConfig, ModalVariant } from '../types/componentAdapter';
import { useObsidianOverlayActive } from './useObsidianOverlayActive';
import { useObsidianReducedMotion } from '../ui/useObsidianReducedMotion';

interface BaseModalProps {
    /** Controls modal visibility - triggers enter/exit animations */
    isOpen?: boolean;
    onClose: () => void;
    dismissible?: boolean;
    overlays?: React.ReactNode;
    finalFocus?: () => HTMLElement | false | null;
    children: React.ReactNode;
    className?: string;
    showDragHandle?: boolean;
    showBackdrop?: boolean;
    zIndex?: number;
    animationConfig?: AnimationConfig;
    variant?: ModalVariant;
    /** Additional styles for the outer wrapper */
    style?: React.CSSProperties;
    /** Additional styles for the modal surface */
    contentStyle?: React.CSSProperties;
    /** Called when exit animation completes */
    onExitComplete?: () => void;
    /** Called when entry animation completes (modal is fully visible) */
    onAnimationComplete?: () => void;
    /** Disable swipe-to-dismiss gesture (default: false for bottom-sheet, true for centered) */
    disableSwipeToDismiss?: boolean;
    /** Accessible name for the dialog surface. */
    ariaLabel?: string;
    /** ID of an element that labels the dialog surface. */
    ariaLabelledBy?: string;
    ariaDescribedBy?: string;
    role?: 'dialog' | 'alertdialog';
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}

/** Base UI owns dismissal, focus and gestures; the portal stays in its host's theme and document. */
export function BaseModal({
    isOpen = true, onClose, children, className = '', showDragHandle = true,
    showBackdrop = true, zIndex = 60, animationConfig = { enabled: true },
    variant = 'bottom-sheet', style, contentStyle, onExitComplete, onAnimationComplete,
    disableSwipeToDismiss, dismissible = true, ariaLabel, ariaLabelledBy,
    ariaDescribedBy, role = 'dialog', onKeyDown, overlays, finalFocus,
}: BaseModalProps) {
    const reducedMotion = useObsidianReducedMotion();
    const [container, setContainer] = useState<HTMLDivElement | null>(null);
    const [mounted, setMounted] = useState(false);
    const hostActive = useObsidianOverlayActive(container);
    const popupRef = useRef<HTMLDivElement>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const captureContainer = React.useCallback((element: HTMLDivElement | null) => {
        if (element && isOpen && !returnFocusRef.current) {
            let active = element.ownerDocument.activeElement;
            while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
            returnFocusRef.current = active as HTMLElement | null;
        }
        setContainer(element);
    }, [isOpen]);
    useLayoutEffect(() => { if (container) setMounted(true); }, [container]);
    const bottomSheet = variant === 'bottom-sheet';
    const Root = bottomSheet ? Drawer.Root : Dialog.Root;
    const Portal = bottomSheet ? Drawer.Portal : Dialog.Portal;
    const Backdrop = bottomSheet ? Drawer.Backdrop : Dialog.Backdrop;
    const Popup = bottomSheet ? Drawer.Popup : Dialog.Popup;
    const surfaceClass = bottomSheet
        ? 'base-modal-surface is-bottom-sheet relative w-full'
        : 'base-modal-surface is-centered max-w-lg w-full mx-4';
    const contents = <>
        {showDragHandle && bottomSheet && <div className="base-modal-drag-region flex justify-center pt-3 pb-1">
            <div className="base-modal-drag-handle" />
        </div>}
        {children}
    </>;
    const popup = <Popup
        ref={popupRef}
        className={`${surfaceClass} ${className}`}
        style={contentStyle}
        role={role}
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        initialFocus={() => popupRef.current?.querySelector<HTMLElement>('[data-initial-focus], [contenteditable="true"]') ?? popupRef.current}
        finalFocus={finalFocus ?? (() => returnFocusRef.current?.isConnected ? returnFocusRef.current : true)}
        onKeyDown={onKeyDown}
        data-base-ui-swipe-ignore={disableSwipeToDismiss || !dismissible ? '' : undefined}
    >{bottomSheet ? <Drawer.Content className="base-modal-content">{contents}</Drawer.Content> : contents}</Popup>;
    return <>
        <div ref={captureContainer} className="base-modal-portal" />
        <Root
            open={isOpen && mounted}
            modal={hostActive ? 'trap-focus' : false}
            disablePointerDismissal={!hostActive || !dismissible}
            onOpenChange={(open, details) => {
                if (open) return;
                if (!dismissible || !hostActive) { details.cancel(); return; }
                onClose();
            }}
            onOpenChangeComplete={(open) => {
                if (open) onAnimationComplete?.();
                else if (!isOpen) onExitComplete?.();
            }}
        >
            {container && <Portal container={container}>
                <div
                    className={`base-modal-container fixed inset-0 ${bottomSheet ? 'flex flex-col justify-end' : 'flex items-center justify-center'}`}
                    data-no-animation={!animationConfig.enabled || reducedMotion ? '' : undefined}
                    style={{ zIndex, ...style }}
                >
                    <Backdrop className={`base-modal-backdrop absolute inset-0${showBackdrop ? ' modal-backdrop' : ''}`} />
                    {bottomSheet ? <Drawer.Viewport className="base-modal-viewport">{popup}</Drawer.Viewport> : popup}
                </div>
            </Portal>}
            {overlays}
        </Root>
    </>;
}
