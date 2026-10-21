import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BaseModal } from '../../../ui/shared/BaseModal';
import { ModalHeader } from '../../../ui/shared/ModalHeader';
import { useObsidianKeyboardHeight } from '../../../reminders/ui/hooks/useObsidianKeyboardHeight';
import type { ReadingDialogProps } from '../ReadingDialog';

/** Base UI keeps plugin portals inside the same document and Obsidian shadow root. */
export function PluginReadingDialog({ title, action, variant = 'bottom-sheet', showBackdrop = true, fullHeight = false, onClose, busy = false, children, className = '', contentClassName = 'crate-reading', contained = false }: ReadingDialogProps & { contained?: boolean }) {
	const marker = useRef<HTMLDivElement>(null);
	const keyboardInset = useObsidianKeyboardHeight(true);
	const [closing, setClosing] = useState(false);
	const close = () => { if (!busy) setClosing(true); };
	return <div ref={marker}><BaseModal isOpen={!closing} onClose={close} onExitComplete={onClose} dismissible={!busy && !closing} ariaLabel={title} variant={variant} showBackdrop={showBackdrop} className={`crate-reading-dialog${fullHeight ? ' crate-reading-dialog--full' : ''} ${className}`}
		style={{ bottom: contained ? 0 : keyboardInset }} contentStyle={{ maxHeight: contained ? 'calc(100% - 20px)' : `calc(100dvh - ${keyboardInset + 20}px - env(safe-area-inset-top))` }}>
		<ModalHeader action={action} title={title} closeLabel={`Close ${title.toLowerCase()}`} closeDisabled={busy || closing} onClose={close} />
		<div className={`crate-modal-body ${contentClassName}`}>{typeof children === 'function' ? children(close) : children}</div>
	</BaseModal></div>;
}

/** Keep overlays inside the pane, but outside its clipped tab and reader layers. */
export function ObsidianReadingDialog(props: ReadingDialogProps) {
	const marker = useRef<HTMLDivElement>(null);
	const [container, setContainer] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		const pane = marker.current?.closest('.plugin-workspace-navigation') ?? marker.current?.closest('.crate-reading-workspace');
		if (!pane) return;
		const overlay = pane.ownerDocument.createElement('div');
		overlay.className = 'crate-reading-pane-overlay';
		pane.append(overlay);
		setContainer(overlay);
		return () => overlay.remove();
	}, []);
	return <><div ref={marker} />{container && createPortal(<PluginReadingDialog {...props} contained />, container)}</>;
}
