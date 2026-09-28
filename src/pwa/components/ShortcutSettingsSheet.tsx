import { useCallback, useLayoutEffect, useState, type ReactNode } from 'react';
import { ModalHeader } from '@/ui/shared/ModalHeader';
import { useSheetTransition } from '../hooks/useSheetTransition';
import { PwaModalSheet } from './PwaModalSheet';

/** Keep setup mounted through dismissal, then complete its browser Back entry. */
export function ShortcutSettingsSheet({ open, onClose, onCloseEnd, children }: {
	open: boolean;
	onClose: () => void;
	onCloseEnd: () => void;
	children: ReactNode;
}) {
	const [mounted, setMounted] = useState(open);
	const finish = useCallback(() => { setMounted(false); onCloseEnd(); }, [onCloseEnd]);
	const { isClosing, requestClose, cancelClose, finishClose } = useSheetTransition(finish);
	useLayoutEffect(() => {
		if (open) { setMounted(true); cancelClose(); }
		else if (mounted) requestClose();
	}, [open, mounted, requestClose, cancelClose]);
	if (!mounted) return null;
	const close = () => { onClose(); requestClose(); };
	return <PwaModalSheet isOpen={open && !isClosing} onClose={close} onCloseEnd={finishClose}
		variant="settings" sheetClassName="pwa-shortcut-sheet" label="Set up iPhone shortcut" recedeCanvas={false}>
		<aside className="settings-sheet settings-sheet--unified outline-none" data-pwa-back={open} tabIndex={-1}>
			<ModalHeader title="Set up iPhone shortcut" closeLabel="Close shortcut setup" onClose={close} closeDisabled={isClosing} />
			<div className="settings-panel settings-shortcut-body" data-base-ui-swipe-ignore="">
				<div className="crate-reading settings-subpage">{children}</div>
			</div>
		</aside>
	</PwaModalSheet>;
}
