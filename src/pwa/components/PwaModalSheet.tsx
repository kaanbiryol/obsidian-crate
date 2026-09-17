import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Drawer } from '@base-ui/react/drawer';
import { lockSheetDocumentScroll } from '../sheet-scroll-lock';
import { measureSheetTravel } from '../sheet-geometry';

export function PwaModalSheet({
	isOpen, onClose, onCloseEnd, onOpenEnd, children, variant, sheetClassName,
	keyboardInset = 0, dismissible = true, label, role = 'dialog', descriptionId,
}: {
	isOpen: boolean;
	/** Return false when dismissal navigates within the sheet instead of closing it. */
	onClose: (reason: Drawer.Root.ChangeEventReason) => boolean | void;
	onCloseEnd: () => void;
	onOpenEnd?: () => void;
	children: React.ReactNode;
	variant: 'reminder' | 'settings';
	sheetClassName?: string;
	keyboardInset?: number;
	dismissible?: boolean;
	label: string;
	role?: 'dialog' | 'alertdialog';
	descriptionId?: string;
}) {
	// Retain the iOS layout/selection-safe lock through the exit animation.
	// Base UI owns focus containment; trap-focus avoids a second document lock.
	useLayoutEffect(lockSheetDocumentScroll, []);
	const popupRef = useRef<HTMLDivElement>(null);
	const setPopupRef = useCallback((popup: HTMLDivElement | null) => {
		popupRef.current = popup;
		measureSheetTravel(popup);
	}, []);
	useLayoutEffect(() => {
		// Snapshot before exit, including the currently visible keyboard inset.
		// Do not retarget travel on every frame of the keyboard animation.
		if (!isOpen) measureSheetTravel(popupRef.current);
	}, [isOpen]);
	const [previousFocus] = useState(() => typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const [hasMounted, setHasMounted] = useState(false);
	const [mountPoint, setMountPoint] = useState(() => typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.pwa-shadow-root'));
	useLayoutEffect(() => {
		// A notification can mount the app root and sheet in the same commit.
		if (!mountPoint) setMountPoint(document.querySelector<HTMLElement>('.pwa-shadow-root'));
		// Base UI skips entrance transitions when initially open. Open before paint
		// after mounting its root, retaining synchronous first-tap editor focus.
		else setHasMounted(true);
	}, [mountPoint]);
	useLayoutEffect(() => {
		if (role === 'alertdialog') popupRef.current?.focus({ preventScroll: true });
	}, [role, hasMounted]);
	if (!mountPoint) return null;

	return (
		<Drawer.Root open={isOpen && hasMounted} modal="trap-focus" swipeDirection="down"
			disablePointerDismissal={!dismissible}
			onOpenChange={(open, details) => {
				if (open) return;
				if (!dismissible) { details.cancel(); return; }
				// Commit controlled dismissal before Base UI checks whether a swipe
				// was accepted. Otherwise a busy frame can start snapping it back.
				let accepted = false;
				flushSync(() => { accepted = onClose(details.reason) !== false; });
				if (!accepted) details.cancel();
			}}
			onOpenChangeComplete={(open) => {
				if (open) onOpenEnd?.();
				else if (!isOpen) onCloseEnd();
			}}
		>
			<Drawer.Portal container={mountPoint}>
				<div className={`pwa-modal-sheet pwa-modal-sheet--${variant}${sheetClassName ? ` ${sheetClassName}` : ''}${keyboardInset > 0 ? ' is-keyboard-open' : ''}`}>
					<div className="pwa-modal-sheet__scroll-boundary" onTouchStartCapture={(event) => {
						// WebKit focus can scroll this invisible one-pixel boundary to
						// its end. Start header drags at its top so Base UI does not
						// mistake the containment layer for content that must scroll.
						if (event.target instanceof Element && event.target.closest('.reminder-modal-header')) {
							event.currentTarget.scrollTop = 0;
						}
					}}>
						<div className="pwa-modal-sheet__scroll-track">
							<Drawer.Viewport className="pwa-modal-sheet__viewport">
								<Drawer.Backdrop className="pwa-modal-sheet__backdrop" />
								<Drawer.Popup ref={setPopupRef}
									className={`pwa-modal-sheet__container pwa-modal-sheet__container--${variant}`}
									role={role} aria-label={label} aria-modal="true" aria-describedby={descriptionId}
									data-base-ui-swipe-ignore={!dismissible ? '' : undefined}
									initialFocus={variant === 'reminder' ? false : popupRef}
									finalFocus={() => previousFocus?.isConnected && previousFocus !== document.body ? previousFocus
										: document.querySelector<HTMLElement>('.pwa-shadow-root .reminder-pagination select:not(:disabled)')
											?? document.querySelector<HTMLElement>('.pwa-shadow-root .sidebar-reminder-card-wrapper')
											?? document.querySelector<HTMLElement>('.pwa-shadow-root [data-action="switch-tab"][aria-current="page"]')}
								>
									<Drawer.Content className="pwa-modal-sheet__content">
										<div className="pwa-modal-sheet__scroller">{children}</div>
									</Drawer.Content>
								</Drawer.Popup>
							</Drawer.Viewport>
						</div>
					</div>
				</div>
			</Drawer.Portal>
		</Drawer.Root>
	);
}
