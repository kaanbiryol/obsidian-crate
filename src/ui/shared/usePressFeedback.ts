import { useEffect, useRef, useState, type HTMLAttributes } from 'react';

/** Momentary feedback only: never selection, focus, or touch-emulated :active. */
export function usePressFeedback<T extends HTMLElement>() {
	const [pressed, setPressed] = useState(false);
	const origin = useRef<{ x: number; y: number } | null>(null);
	const owner = useRef<T | null>(null);
	const clearPress = () => { origin.current = null; setPressed(false); };
	useEffect(() => {
		if (!pressed || !owner.current) return;
		const document = owner.current.ownerDocument, window = document.defaultView;
		const clear = () => { origin.current = null; setPressed(false); };
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
			setPressed(true);
		},
		onPointerMove: event => {
			const start = origin.current;
			if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) clearPress();
		},
		onPointerUp: clearPress, onPointerCancel: clearPress, onPointerLeave: clearPress,
		onLostPointerCapture: clearPress, onBlur: clearPress,
		onKeyDown: event => {
			if (event.target !== event.currentTarget || ![' ', 'Enter'].includes(event.key) || event.currentTarget.closest('[inert], :disabled')) return;
			owner.current = event.currentTarget;
			setPressed(true);
		},
		onKeyUp: clearPress,
		onClickCapture: clearPress,
	} satisfies HTMLAttributes<T>;
	return { pressed, events, clearPress };
}
