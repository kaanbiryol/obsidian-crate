import { ModalHeader } from '@/ui/shared/ModalHeader';
import type { ReadingDialogProps } from '@/reading/ui/ReadingDialog';
import { PwaModalSheet } from '../components/PwaModalSheet';
import { useSheetTransition } from '../hooks/useSheetTransition';

export function PwaReadingDialog({ title, action, children, onClose, busy = false, fullHeight = false, className = '', contentClassName = 'crate-reading' }: ReadingDialogProps) {
	const transition = useSheetTransition(onClose);
	return <PwaModalSheet isOpen={!transition.isClosing} onClose={transition.requestClose} onCloseEnd={transition.finishClose}
		variant="settings" viewportPortal sheetClassName={fullHeight ? 'pwa-reading-full-height' : undefined} label={title} dismissible={!busy && !transition.isClosing}>
		<section className={`settings-sheet pwa-reading-sheet ${fullHeight ? 'settings-sheet--full-height' : ''} ${className}`} aria-busy={busy || transition.isClosing}>
			<ModalHeader action={action ? { ...action, disabled: action.disabled || busy || transition.isClosing } : undefined} preventFocusOnPress title={title} closeLabel={`Close ${title.toLowerCase()}`} closeDisabled={busy || transition.isClosing} onClose={transition.requestClose} />
			<div className={`settings-panel ${contentClassName}`} data-base-ui-swipe-ignore="">
				{typeof children === 'function' ? children(transition.requestClose) : children}
			</div>
		</section>
	</PwaModalSheet>;
}
