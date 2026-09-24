import { ModalHeader } from '@/ui/shared/ModalHeader';
import type { ReadingDialogProps } from '@/reading/ui/ReadingDialog';
import { useKeyboardHeight } from '@/reminders/ui/hooks/useKeyboardHeight';
import { PwaModalSheet } from '../components/PwaModalSheet';
import { useSheetTransition } from '../hooks/useSheetTransition';

export function PwaReadingDialog({ title, children, onClose, busy = false, className = '', contentClassName = 'crate-reading' }: ReadingDialogProps) {
	const transition = useSheetTransition(onClose);
	const keyboardInset = useKeyboardHeight();
	return <PwaModalSheet isOpen={!transition.isClosing} onClose={transition.requestClose} onCloseEnd={transition.finishClose}
		variant="settings" label={title} dismissible={!busy && !transition.isClosing} keyboardInset={keyboardInset}>
		<section className={`settings-sheet pwa-reading-sheet ${className}`} aria-busy={busy || transition.isClosing}>
			<ModalHeader title={title} closeLabel={`Close ${title.toLowerCase()}`} closeDisabled={busy || transition.isClosing} onClose={transition.requestClose} />
			<div className={`settings-panel ${contentClassName}`} data-base-ui-swipe-ignore="">
				{typeof children === 'function' ? children(transition.requestClose) : children}
			</div>
		</section>
	</PwaModalSheet>;
}
