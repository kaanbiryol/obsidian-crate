import { createContext, useContext } from 'react';
import { ModalHeader } from '@/ui/shared/ModalHeader';
import type { ReadingDialogProps } from '@/reading/ui/ReadingDialog';
import { PwaModalSheet } from '../components/PwaModalSheet';
import { useSheetTransition } from '../hooks/useSheetTransition';

// Only a full-height sheet recedes the app; one opened from another reading sheet stacks over it.
const NestedReadingSheet = createContext(false);

export function PwaReadingDialog({ title, action, children, onClose, busy = false, fullHeight = false, className = '', contentClassName = 'crate-reading' }: ReadingDialogProps) {
	const transition = useSheetTransition(onClose);
	const nested = useContext(NestedReadingSheet);
	return <PwaModalSheet isOpen={!transition.isClosing} onClose={transition.requestClose} onCloseEnd={transition.finishClose}
		variant="settings" viewportPortal recedeCanvas={fullHeight && !nested} sheetClassName={fullHeight ? 'pwa-reading-full-height' : undefined} label={title} dismissible={!busy && !transition.isClosing}>
		<section className={`settings-sheet pwa-reading-sheet ${fullHeight ? 'settings-sheet--full-height' : ''} ${className}`} aria-busy={busy || transition.isClosing}>
			<ModalHeader action={action ? { ...action, icon: action.type === 'submit' ? 'arrow-up' : action.icon, disabled: action.disabled || busy || transition.isClosing } : undefined} preventFocusOnPress title={title} closeLabel={`Close ${title.toLowerCase()}`} closeDisabled={busy || transition.isClosing} onClose={transition.requestClose} />
			<div className={`settings-panel ${contentClassName}`}>
				<NestedReadingSheet.Provider value>{typeof children === 'function' ? children(transition.requestClose) : children}</NestedReadingSheet.Provider>
			</div>
		</section>
	</PwaModalSheet>;
}
