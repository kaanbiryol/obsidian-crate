import { useEffect, useRef, useState, type HTMLAttributes } from 'react';

// Like UIKit's delayed content touches: a touch that turns into a scroll
// should never flash the row it started on. A quick tap still flashes briefly.
const TOUCH_PRESS_DELAY_MS = 90;
const TAP_FLASH_MS = 120;

/** Momentary feedback only: never selection, focus, or touch-emulated :active. */
export function usePressFeedback<T extends HTMLElement>() {
	const [pressed, setPressed] = useState(false);
	const origin = useRef<{ x: number; y: number } | null>(null);
	const owner = useRef<T | null>(null);
	const timer = useRef<{ kind: 'delay' | 'flash'; id: number } | null>(null);
	const cancelTimer = () => { if (timer.current) window.clearTimeout(timer.current.id); timer.current = null; };
	const clearPress = () => { cancelTimer(); origin.current = null; setPressed(false); };
	const release = () => {
		if (timer.current?.kind !== 'delay') { clearPress(); return; }
		cancelTimer();
		origin.current = null;
		setPressed(true);
		timer.current = { kind: 'flash', id: window.setTimeout(() => { timer.current = null; setPressed(false); }, TAP_FLASH_MS) };
	};
	useEffect(() => cancelTimer, []);
	useEffect(() => {
		if (!pressed || !owner.current) return;
		const document = owner.current.ownerDocument, window = document.defaultView;
		const clear = () => { cancelTimer(); origin.current = null; setPressed(false); };
		// Release can occur outside the control, or after a sheet makes it inert.
		document.addEventListener('pointerup', clear, true);
		document.addEventListener('pointercancel', clear, true);
		document.addEventListener('keyup', clear, true);
		document.addEventListener('visibilitychange', clear);
		window?.addEventListener('blur', clear);
		return () => {
			document.removeEventListener('pointerup', clear, true);
			document.removeEventListener('pointercancel', clear, true);
			document.removeEventListener('keyup', clear, true);
			document.removeEventListener('visibilitychange', clear);
			window?.removeEventListener('blur', clear);
		};
	}, [pressed]);
	const events = {
		onPointerDown: event => {
			if (!event.isPrimary || event.button !== 0 || event.currentTarget.closest('[inert], :disabled')) return;
			owner.current = event.currentTarget;
			origin.current = { x: event.clientX, y: event.clientY };
			cancelTimer();
			if (event.pointerType !== 'touch') { setPressed(true); return; }
			timer.current = { kind: 'delay', id: window.setTimeout(() => { timer.current = null; setPressed(true); }, TOUCH_PRESS_DELAY_MS) };
		},
		onPointerMove: event => {
			const start = origin.current;
			if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) clearPress();
		},
		onPointerUp: release, onPointerCancel: clearPress, onPointerLeave: event => { if (event.pointerType !== 'touch' || timer.current?.kind !== 'flash') clearPress(); },
		onLostPointerCapture: clearPress, onBlur: clearPress,
		onKeyDown: event => {
			if (event.target !== event.currentTarget || ![' ', 'Enter'].includes(event.key) || event.currentTarget.closest('[inert], :disabled')) return;
			owner.current = event.currentTarget;
			setPressed(true);
		},
		onKeyUp: clearPress,
		// The click follows a quick tap's release; keep that tap's flash.
		onClickCapture: () => { if (timer.current?.kind !== 'flash') clearPress(); },
	} satisfies HTMLAttributes<T>;
	return { pressed, events, clearPress };
}
