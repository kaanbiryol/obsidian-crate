import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ModalHeader } from '../shared/ModalHeader';
import { ThemeIconProvider } from '../../reminders/components/theme-icon';
import { ObsidianIcon } from '../../reminders/components/obsidian-icon';
import { BaseModal } from '../../reminders/components/BaseModal';

interface ActivitySheetProps {
    isMobile: boolean;
    animationsEnabled?: boolean;
    onClose: () => void;
    onMount: (container: HTMLDivElement, close: () => void, header: HTMLDivElement) => void;
}

export function ActivitySheet({ isMobile, animationsEnabled = true, onClose, onMount }: ActivitySheetProps) {
    const [isOpen, setIsOpen] = useState(true);
    const close = useCallback(() => {
        if (animationsEnabled) setIsOpen(false);
        else onClose();
    }, [animationsEnabled, onClose]);

    return (
        <BaseModal
            isOpen={isOpen}
            animationConfig={{ enabled: animationsEnabled }}
            onClose={close}
            onExitComplete={onClose}
            variant={isMobile ? 'bottom-sheet' : 'centered'}
            className="crate-reminder-editor-surface crate-activity-surface"
            ariaLabel="Sync activity"
            showBackdrop={false}
            showDragHandle={false}
            disableSwipeToDismiss
        >
            <ActivityContent close={close} onMount={onMount} />
        </BaseModal>
    );
}

function ActivityContent({ close, onMount }: { close: () => void; onMount: ActivitySheetProps['onMount'] }) {
    const headerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const container = contentRef.current;
        if (!container || !headerRef.current) return;
        onMount(container, close, headerRef.current);
        container.closest<HTMLElement>('.crate-activity-surface')?.focus({ preventScroll: true });
    }, [close, onMount]);

    return (
        <div className="crate-activity-modal">
            <div ref={headerRef} className="crate-modal-header-host">
                <ThemeIconProvider renderer={ObsidianIcon}>
                    <ModalHeader title="Sync activity" closeLabel="Close sync activity" onClose={close} />
                </ThemeIconProvider>
            </div>
            <div ref={contentRef} className="crate-activity-body" />
        </div>
    );
}
