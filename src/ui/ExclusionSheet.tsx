import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ModalHeader } from './shared/ModalHeader';
import { ThemeIconProvider } from '../reminders/components/theme-icon';
import { ObsidianIcon } from '../reminders/components/obsidian-icon';
import { BaseModal } from '../reminders/components/BaseModal';

interface ExclusionSheetProps {
    animationsEnabled?: boolean;
    onClose: () => void;
    onMount: (container: HTMLDivElement, close: () => void) => void;
}

export function ExclusionSheet({ animationsEnabled = true, onClose, onMount }: ExclusionSheetProps) {
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
            variant="bottom-sheet"
            className="crate-reminder-editor-surface crate-exclusion-surface"
            ariaLabel="Excluded files"
            showBackdrop={false}
            showDragHandle={false}
            disableSwipeToDismiss
        >
            <ExclusionContent close={close} onMount={onMount} />
        </BaseModal>
    );
}

function ExclusionContent({ close, onMount }: { close: () => void; onMount: ExclusionSheetProps['onMount'] }) {
    const headerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const container = contentRef.current;
        if (!container || !headerRef.current) return;
        onMount(container, close);
        container.closest<HTMLElement>('.crate-exclusion-surface')?.focus({ preventScroll: true });
    }, [close, onMount]);

    return (
        <div className="crate-exclusion-modal">
            <div ref={headerRef} className="crate-modal-header-host">
                <ThemeIconProvider renderer={ObsidianIcon}>
                    <ModalHeader title="Excluded files" closeLabel="Close excluded files" onClose={close} />
                </ThemeIconProvider>
            </div>
            <div ref={contentRef} className="crate-exclusion-body" />
        </div>
    );
}
