import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { BaseModal } from '../../reminders/components/BaseModal';

interface ActivitySheetProps {
    isMobile: boolean;
    onClose: () => void;
    onMount: (container: HTMLDivElement, close: () => void) => void;
}

export function ActivitySheet({ isMobile, onClose, onMount }: ActivitySheetProps) {
    const [isOpen, setIsOpen] = useState(true);
    const contentRef = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setIsOpen(false), []);

    useLayoutEffect(() => {
        const container = contentRef.current;
        if (!container) return;
        onMount(container, close);
        container.closest<HTMLElement>('.crate-activity-surface')?.focus({ preventScroll: true });
    }, [close, onMount]);

    return (
        <BaseModal
            isOpen={isOpen}
            onClose={close}
            onExitComplete={onClose}
            variant={isMobile ? 'bottom-sheet' : 'centered'}
            className="crate-reminder-editor-surface crate-activity-surface"
            ariaLabel="Sync activity"
            showBackdrop={false}
            showDragHandle={false}
            disableSwipeToDismiss
        >
            <div ref={contentRef} className="crate-activity-modal" />
        </BaseModal>
    );
}
