import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ModalHeader } from '../shared/ModalHeader';
import { ThemeIconProvider } from '@/ui/shared/ThemeIcon';
import { ObsidianIcon } from '@/ui/obsidian-icon';
import { BaseModal } from '../shared/BaseModal';

/** Sync activity and the excluded files preview share this sheet frame. */
const SHEETS = {
	activity: { title: 'Sync activity', closeLabel: 'Close sync activity' },
	exclusion: { title: 'Excluded files', closeLabel: 'Close excluded files' },
} as const;

interface ActivitySheetProps {
	kind?: keyof typeof SHEETS;
	isMobile: boolean;
	animationsEnabled?: boolean;
	onClose: () => void;
	onMount: (container: HTMLDivElement, close: () => void, header: HTMLDivElement) => void;
}

export function ActivitySheet({ kind = 'activity', isMobile, animationsEnabled = true, onClose, onMount }: ActivitySheetProps) {
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
			className={`crate-reminder-editor-surface crate-${kind}-surface`}
			ariaLabel={SHEETS[kind].title}
			showBackdrop={false}
			showDragHandle={false}
			disableSwipeToDismiss
		>
			<SheetContent kind={kind} close={close} onMount={onMount} />
		</BaseModal>
	);
}

function SheetContent({ kind, close, onMount }: { kind: keyof typeof SHEETS; close: () => void; onMount: ActivitySheetProps['onMount'] }) {
	const headerRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const container = contentRef.current;
		if (!container || !headerRef.current) return;
		onMount(container, close, headerRef.current);
		container.closest<HTMLElement>(`.crate-${kind}-surface`)?.focus({ preventScroll: true });
	}, [kind, close, onMount]);

	return (
		<div className={`crate-${kind}-modal`}>
			<div ref={headerRef} className="crate-modal-header-host">
				<ThemeIconProvider renderer={ObsidianIcon}>
					<ModalHeader title={SHEETS[kind].title} closeLabel={SHEETS[kind].closeLabel} onClose={close} />
				</ThemeIconProvider>
			</div>
			<div ref={contentRef} className={`crate-${kind}-body`} />
		</div>
	);
}
