import React, { createContext, useContext, useRef, useState } from 'react';
import { BaseModal } from '../../reminders/components/BaseModal';
import { ModalHeader } from '../../ui/shared/ModalHeader';
import { useKeyboardHeight } from '../../reminders/ui/hooks/useKeyboardHeight';

export interface ReadingDialogProps {
	className?: string;
	contentClassName?: string;
	title: string;
	/** Plugin modal shells match the reminder editor on desktop and mobile. */
	variant?: 'centered' | 'bottom-sheet';
	showBackdrop?: boolean;
	action?: React.ComponentProps<typeof ModalHeader>['action'];
	onClose: () => void;
	busy?: boolean;
	/** Use a full-width, tall sheet instead of sizing to the contents. */
	fullHeight?: boolean;
	children: React.ReactNode | ((close: () => void) => React.ReactNode);
}

/** The host owns sheet gestures, keyboard geometry, and exit lifetime. */
export const ReadingDialogHost = createContext<React.ComponentType<ReadingDialogProps> | null>(null);

export function ReadingDialog(props: ReadingDialogProps) {
	const Host = useContext(ReadingDialogHost) ?? PluginReadingDialog;
	return <Host {...props} />;
}

/** Base UI keeps plugin portals inside the same document and Obsidian shadow root. */
export function PluginReadingDialog({ title, action, variant = 'bottom-sheet', showBackdrop = true, fullHeight = false, onClose, busy = false, children, className = '', contentClassName = 'crate-reading', contained = false }: ReadingDialogProps & { contained?: boolean }) {
	const marker = useRef<HTMLDivElement>(null);
	const keyboardInset = useKeyboardHeight(true);
	const [closing, setClosing] = useState(false);
	const close = () => { if (!busy) setClosing(true); };
	return <div ref={marker}><BaseModal isOpen={!closing} onClose={close} onExitComplete={onClose} dismissible={!busy && !closing} ariaLabel={title} variant={variant} showBackdrop={showBackdrop} className={`crate-reading-dialog${fullHeight ? ' crate-reading-dialog--full' : ''} ${className}`}
		style={{ bottom: contained ? 0 : keyboardInset }} contentStyle={{ maxHeight: contained ? 'calc(100% - 20px)' : `calc(100dvh - ${keyboardInset + 20}px - env(safe-area-inset-top))` }}>
		<ModalHeader action={action} title={title} closeLabel={`Close ${title.toLowerCase()}`} closeDisabled={busy || closing} onClose={close} />
		<div className={`crate-modal-body ${contentClassName}`}>{typeof children === 'function' ? children(close) : children}</div>
	</BaseModal></div>;
}
