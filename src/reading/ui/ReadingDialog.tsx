import React, { createContext, useContext, useRef } from 'react';
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
function PluginReadingDialog({ title, action, variant = 'bottom-sheet', showBackdrop = true, fullHeight = false, onClose, busy = false, children, className = '', contentClassName = 'crate-reading' }: ReadingDialogProps) {
	const marker = useRef<HTMLDivElement>(null);
	const keyboardInset = useKeyboardHeight(true);
	return <div ref={marker}><BaseModal onClose={onClose} dismissible={!busy} ariaLabel={title} variant={variant} showBackdrop={showBackdrop} className={`crate-reading-dialog${fullHeight ? ' crate-reading-dialog--full' : ''} ${className}`}
		style={{ bottom: keyboardInset }} contentStyle={{ maxHeight: `calc(100dvh - ${keyboardInset + 20}px - env(safe-area-inset-top))` }}>
		<ModalHeader action={action} title={title} closeLabel={`Close ${title.toLowerCase()}`} closeDisabled={busy} onClose={onClose} />
		<div className={`crate-modal-body ${contentClassName}`}>{typeof children === 'function' ? children(onClose) : children}</div>
	</BaseModal></div>;
}
