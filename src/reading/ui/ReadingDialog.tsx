import React, { createContext, useContext } from 'react';
import type { ModalHeader } from '../../ui/shared/ModalHeader';

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
	/** Confirmations stack without pushing back the sheet they cover, like reminder deletion. */
	role?: 'dialog' | 'alertdialog';
	children: React.ReactNode | ((close: () => void) => React.ReactNode);
}

/** The host owns sheet gestures, keyboard geometry, and exit lifetime. */
export const ReadingDialogHost = createContext<React.ComponentType<ReadingDialogProps> | null>(null);

export function ReadingDialog(props: ReadingDialogProps) {
	const Host = useContext(ReadingDialogHost);
	if (!Host) throw new Error('ReadingDialog needs a ReadingDialogHost provider.');
	return <Host {...props} />;
}

