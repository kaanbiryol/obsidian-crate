import React, { useLayoutEffect, useRef, useState } from 'react';
import { BaseModal } from '../../reminders/components/BaseModal';
import { ModalHeader } from '../../ui/shared/ModalHeader';
import { useKeyboardHeight } from '../../reminders/ui/hooks/useKeyboardHeight';

/** Base UI keeps focus and portals inside the same document and Obsidian shadow root. */
export function ReadingDialog({ title, onClose, busy = false, children, className = '' }: { className?: string; title: string; onClose: () => void; busy?: boolean; children: React.ReactNode }) {
	const marker = useRef<HTMLDivElement>(null);
	const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 600px)').matches);
	const keyboardInset = useKeyboardHeight(mobile);
	useLayoutEffect(() => {
		const media = marker.current?.ownerDocument.defaultView?.matchMedia('(max-width: 600px)');
		if (!media) return;
		const update = () => setMobile(media.matches); update();
		media.addEventListener('change', update); return () => media.removeEventListener('change', update);
	}, []);
	return <div ref={marker}><BaseModal onClose={onClose} dismissible={!busy} ariaLabel={title} variant={mobile ? 'bottom-sheet' : 'centered'} className={`crate-reading-dialog ${className}`}
		style={mobile ? { bottom: keyboardInset } : undefined} contentStyle={mobile ? { maxHeight: `calc(100dvh - ${keyboardInset + 20}px - env(safe-area-inset-top))` } : undefined}>
		<ModalHeader title={title} closeLabel={`Close ${title.toLowerCase()}`} closeDisabled={busy} onClose={onClose} />
		<div className="crate-reading crate-modal-body">{children}</div>
	</BaseModal></div>;
}
