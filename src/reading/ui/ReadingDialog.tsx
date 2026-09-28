import React, { createContext, useContext, useRef } from 'react';
import { BaseModal } from '../../reminders/components/BaseModal';
import { ModalHeader } from '../../ui/shared/ModalHeader';
import { useKeyboardHeight } from '../../reminders/ui/hooks/useKeyboardHeight';

export interface ReadingDialogProps {
	className?: string;
	contentClassName?: string;
	title: string;
	action?: React.ComponentProps<typeof ModalHeader>['action'];
	onClose: () => void;
	busy?: boolean;
	/** Use the PWA settings page height instead of sizing to the contents. */
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
function PluginReadingDialog({ title, action, onClose, busy = false, children, className = '', contentClassName = 'crate-reading' }: ReadingDialogProps) {
	const marker = useRef<HTMLDivElement>(null);
	const keyboardInset = useKeyboardHeight(true);
	return <div ref={marker}><BaseModal onClose={onClose} dismissible={!busy} ariaLabel={title} variant="bottom-sheet" className={`crate-reading-dialog ${className}`}
		style={{ bottom: keyboardInset }} contentStyle={{ maxHeight: `calc(100dvh - ${keyboardInset + 20}px - env(safe-area-inset-top))` }}>
		<ModalHeader action={action} title={title} closeLabel={`Close ${title.toLowerCase()}`} closeDisabled={busy} onClose={onClose} />
		<div className={`crate-modal-body ${contentClassName}`}>{typeof children === 'function' ? children(onClose) : children}</div>
	</BaseModal></div>;
}
