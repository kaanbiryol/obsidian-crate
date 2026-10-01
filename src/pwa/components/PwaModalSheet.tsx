import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Drawer } from '@base-ui/react/drawer';
import { lockSheetDocumentScroll } from '../sheet-scroll-lock';
import { measureSheetTravel } from '../sheet-geometry';
import { trackSheetPresentation } from '../sheet-presentation';
import { useKeyboardHeight } from '@/reminders/ui/hooks/useKeyboardHeight';
import { PwaSheetSurface } from './PwaSheetSurface';

export function PwaModalSheet({
	isOpen, onClose, onCloseEnd, onOpenEnd, children, variant, sheetClassName,
	keyboardInset: keyboardInsetOverride, dismissible = true, viewportPortal = false, recedeCanvas = true, label, role = 'dialog', descriptionId,
}: {
	isOpen: boolean;
	/** Return false when dismissal navigates within the sheet instead of closing it. */
	onClose: (reason: Drawer.Root.ChangeEventReason) => boolean | void;
	onCloseEnd: () => void;
	onOpenEnd?: () => void;
	children: React.ReactNode;
	variant: 'reminder' | 'settings';
	sheetClassName?: string;
	/** Measured automatically; override only for coordinated screen handoffs. */
	keyboardInset?: number;
	/** Keep document-reader sheets outside the frozen app and its compositing layers. */
	viewportPortal?: boolean;
	/** A nested sheet leaves the underlying sheet's canvas depth in place. */
	recedeCanvas?: boolean;
	dismissible?: boolean;
	label: string;
	role?: 'dialog' | 'alertdialog';
	descriptionId?: string;
}) {
	const measuredKeyboardInset = useKeyboardHeight(keyboardInsetOverride === undefined);
	const keyboardInset = keyboardInsetOverride ?? measuredKeyboardInset;
	// Retain the iOS layout/selection-safe lock through the exit animation.
	// Base UI owns focus containment; trap-focus avoids a second document lock.
	useLayoutEffect(() => lockSheetDocumentScroll(viewportPortal), [viewportPortal]);
	const popupRef = useRef<HTMLDivElement>(null);
	const anchorRef = useRef<HTMLSpanElement>(null);
	// Final focus can run after the portal anchor has unmounted. Keep the host
	// available when a deleted reminder no longer supplies the original target.
	const focusHostRef = useRef<HTMLElement | null>(null);
	const stopPresentation = useRef<(() => void) | undefined>(undefined);
	const setPopupRef = useCallback((popup: HTMLDivElement | null) => {
		stopPresentation.current?.();
		stopPresentation.current = undefined;
		popupRef.current = popup;
		measureSheetTravel(popup);
		if (popup) stopPresentation.current = trackSheetPresentation(popup, recedeCanvas);
		// The portal can attach after the parent layout effect. Focus in its
		// mount ref so a synchronous opening tap still activates the keyboard.
		popup?.querySelector<HTMLElement>('[data-initial-focus]:not(:disabled)')?.focus({ preventScroll: true });
	}, [recedeCanvas]);
	useLayoutEffect(() => {
		// Snapshot before exit, including the currently visible keyboard inset.
		// Do not retarget travel on every frame of the keyboard animation.
		if (!isOpen) measureSheetTravel(popupRef.current);
	}, [isOpen]);
	const [previousFocus] = useState(() => typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const [hasMounted, setHasMounted] = useState(false);
	const [mountPoint, setMountPoint] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		const host = anchorRef.current?.closest<HTMLElement>('.pwa-shadow-root, .crate-feature-panel');
		if (!host) return;
		focusHostRef.current = host;
		const shell = host.closest<HTMLElement>('.crate-feature-shell');
		const inCanvas = Boolean(host.closest('.crate-modal-canvas'));
		if (!viewportPortal && !inCanvas) { setMountPoint(host); return; }
		// Modal surfaces must be siblings of the receding app canvas, otherwise
		// its transform also shrinks their fixed positioning and gesture geometry.
		// A scrolled document reader keeps its existing viewport/body portal.
		const documentReader = host.ownerDocument.documentElement.classList.contains('pwa-document-reader');
		const portal = host.ownerDocument.createElement('div');
		portal.className = 'crate-reminders-ui pwa-shadow-root pwa-sheet-portal';
		// Retain host theme tokens without inheriting the feature panel's layout.
		if (host.classList.contains('pwa-reading-root')) portal.classList.add('pwa-reading-root');
		(shell && !documentReader ? shell : host.ownerDocument.body).append(portal);
		setMountPoint(portal);
		return () => portal.remove();
	}, [viewportPortal]);
	useLayoutEffect(() => {
		// Base UI skips entrance transitions when initially open. Open before paint
		// after mounting its root, retaining synchronous first-tap editor focus.
		if (mountPoint) setHasMounted(true);
	}, [mountPoint]);
	useLayoutEffect(() => {
		if (role === 'alertdialog') popupRef.current?.focus({ preventScroll: true });
	}, [role, hasMounted]);
	const finalFocus = () => {
		const host = focusHostRef.current;
		const target = () => previousFocus?.isConnected && previousFocus !== document.body ? previousFocus
			: host?.querySelector<HTMLElement>('.reminder-pagination select:not(:disabled), .sidebar-reminder-card-wrapper, [aria-current="page"]');
		// Closing can remove the selected row and clamp its page after Base UI
		// resolves the return target. Recover on the next frame only if focus was lost.
		requestAnimationFrame(() => {
			if (host?.isConnected && !popupRef.current?.isConnected && document.activeElement === document.body) {
				target()?.focus({ preventScroll: true });
			}
		});
		return target();
	};
	return <><span ref={anchorRef} hidden />{mountPoint && (
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
				<div data-recede-canvas={recedeCanvas ? '' : undefined}
					className={`pwa-modal-sheet pwa-modal-sheet--${variant}${sheetClassName ? ` ${sheetClassName}` : ''}${keyboardInset > 0 ? ' is-keyboard-open' : ''}`}>
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
									onPointerDown={(event) => {
										if (event.pointerType !== 'touch' || event.button !== 0 || !(event.target instanceof Element)) return;
										const field = event.target.closest<HTMLElement>('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, [contenteditable="true"]');
										if (field && field !== field.ownerDocument.activeElement) field.focus({ preventScroll: true });
									}}
									initialFocus={variant === 'reminder' ? false : () => popupRef.current?.querySelector<HTMLElement>('[data-initial-focus]:not(:disabled)') ?? popupRef.current}
									finalFocus={finalFocus}
								>
									<Drawer.Content className="pwa-modal-sheet__content">
										<div className="pwa-modal-sheet__scroller">{variant === 'settings'
											? <PwaSheetSurface keyboardInset={keyboardInset} animateKeyboard={isOpen}>{children}</PwaSheetSurface>
											: children}</div>
									</Drawer.Content>
								</Drawer.Popup>
							</Drawer.Viewport>
						</div>
					</div>
				</div>
			</Drawer.Portal>
		</Drawer.Root>
	)}</>;
}
