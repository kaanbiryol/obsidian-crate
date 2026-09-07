import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ModalHeader } from '../shared/ModalHeader';
import { ThemeIconProvider } from '../../reminders/components/theme-icon';
import { ObsidianIcon } from '../../reminders/components/obsidian-icon';
import { BaseModal } from '../../reminders/components/BaseModal';

interface ActivitySheetProps {
    isMobile: boolean;
    onClose: () => void;
    onMount: (container: HTMLDivElement, close: () => void, header: HTMLDivElement) => void;
}

export function ActivitySheet({ isMobile, onClose, onMount }: ActivitySheetProps) {
    const [isOpen, setIsOpen] = useState(true);
    const headerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setIsOpen(false), []);

    useLayoutEffect(() => {
        const container = contentRef.current;
        if (!container || !headerRef.current) return;
        onMount(container, close, headerRef.current);
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
            <div className="crate-activity-modal">
                <div ref={headerRef} className="crate-modal-header-host">
                    <ThemeIconProvider renderer={ObsidianIcon}>
                        <ModalHeader title="Sync activity" closeLabel="Close sync activity" onClose={close} />
                    </ThemeIconProvider>
                </div>
                <div ref={contentRef} className="crate-activity-body" />
            </div>
        </BaseModal>
    );
}
