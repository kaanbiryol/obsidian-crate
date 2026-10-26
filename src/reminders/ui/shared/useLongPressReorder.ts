import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDragControls } from 'motion/react';
import { createReorderClickGuard } from './reorderClickGuard';

const LONG_PRESS_DELAY_MS = 380;
const LONG_PRESS_MOVE_TOLERANCE = 9;
const LONG_PRESS_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [contenteditable="true"], [role="checkbox"]';

interface UseLongPressReorderOptions {
	elementRef: React.RefObject<HTMLDivElement | null>;
	interaction: 'drag' | 'long-press';
	onDragStart: () => void;
	onDragEnd: () => void;
}

/** Start a row drag from a mouse press or a held touch, and suppress the clicks a drag produces. */
export function useLongPressReorder({ elementRef, interaction, onDragStart, onDragEnd }: UseLongPressReorderOptions) {
	const dragControls = useDragControls();
	const [isDragPressed, setIsDragPressed] = useState(false);
	const clickGuardRef = useRef(createReorderClickGuard());
	const longPressTimerRef = useRef<number | null>(null);
	const pressStartRef = useRef<{ x: number; y: number } | null>(null);
	const touchDragActiveRef = useRef(false);
	const [isLongPressArmed, setIsLongPressArmed] = useState(false);
	const [isReordering, setIsReordering] = useState(false);

	const cancelLongPress = useCallback(() => {
		if (longPressTimerRef.current !== null) {
			window.clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
		pressStartRef.current = null;
		setIsLongPressArmed(false);
		setIsDragPressed(false);
	}, []);

	useEffect(() => cancelLongPress, [cancelLongPress]);

	useEffect(() => {
		const element = elementRef.current;
		if (!element) return;
		// Let swipes scroll until the hold activates. Then retain the touch stream
		// for Motion instead of letting native scrolling cancel its pointer events.
		const handleTouchMove = (event: TouchEvent) => {
			if (touchDragActiveRef.current && event.cancelable) event.preventDefault();
		};
		const endTouch = () => {
			touchDragActiveRef.current = false;
			cancelLongPress();
		};
		element.addEventListener('touchmove', handleTouchMove, { passive: false });
		element.addEventListener('touchend', endTouch);
		element.addEventListener('touchcancel', endTouch);
		return () => {
			element.removeEventListener('touchmove', handleTouchMove);
			element.removeEventListener('touchend', endTouch);
			element.removeEventListener('touchcancel', endTouch);
		};
	}, [cancelLongPress, elementRef]);

	useEffect(() => {
		const element = elementRef.current;
		if (!element) return;
		const guard = clickGuardRef.current;
		const handleClick = (event: MouseEvent) => {
			if (!guard.shouldBlock(event)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
		};
		// Cards use native capture listeners, so block at their native ancestor too.
		element.addEventListener('click', handleClick, true);
		element.addEventListener('pointerdown', guard.reset, true);
		return () => {
			element.removeEventListener('click', handleClick, true);
			element.removeEventListener('pointerdown', guard.reset, true);
		};
	}, [elementRef]);

	useEffect(() => {
		if (!isDragPressed && !isLongPressArmed) return;
		// A drag may be released outside the row, where its pointer-up won't bubble.
		window.addEventListener('pointerup', cancelLongPress);
		window.addEventListener('pointercancel', cancelLongPress);
		return () => {
			window.removeEventListener('pointerup', cancelLongPress);
			window.removeEventListener('pointercancel', cancelLongPress);
		};
	}, [cancelLongPress, isDragPressed, isLongPressArmed]);

	const handleDragStart = useCallback(() => {
		cancelLongPress();
		clickGuardRef.current.block();
		setIsReordering(true);
		onDragStart();
	}, [cancelLongPress, onDragStart]);

	const handleDragEnd = useCallback(() => {
		touchDragActiveRef.current = false;
		cancelLongPress();
		setIsReordering(false);
		onDragEnd();
		// Keep suppression until the next pointerdown: touch clicks can arrive late.
	}, [cancelLongPress, onDragEnd]);

	const handleClickCapture = useCallback((e: React.MouseEvent) => {
		if (clickGuardRef.current.shouldBlock(e)) {
			e.stopPropagation();
			e.preventDefault();
		}
	}, []);

	const handleItemPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		if (!event.isPrimary || event.button !== 0) return;
		const target = event.target as Element;
		if (target.closest(LONG_PRESS_INTERACTIVE_SELECTOR)) return;

		cancelLongPress();
		touchDragActiveRef.current = false;
		if (interaction === 'drag' && event.pointerType === 'mouse') {
			setIsDragPressed(true);
			dragControls.start(event);
			return;
		}
		pressStartRef.current = { x: event.clientX, y: event.clientY };
		longPressTimerRef.current = window.setTimeout(() => {
			longPressTimerRef.current = null;
			pressStartRef.current = null;
			setIsLongPressArmed(true);
			touchDragActiveRef.current = event.pointerType === 'touch';
			clickGuardRef.current.block();
			dragControls.start(event);
		}, LONG_PRESS_DELAY_MS);
	}, [cancelLongPress, dragControls, interaction]);

	const handleItemPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		const start = pressStartRef.current;
		if (!start) return;
		if (
			Math.abs(event.clientX - start.x) > LONG_PRESS_MOVE_TOLERANCE
			|| Math.abs(event.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE
		) {
			cancelLongPress();
		}
	}, [cancelLongPress]);

	const handleContextMenu = useCallback((event: React.MouseEvent) => {
		// Android raises its long-press menu while a touch press is arming or dragging the row.
		if (interaction === 'long-press' || longPressTimerRef.current !== null || touchDragActiveRef.current) event.preventDefault();
	}, [interaction]);

	return {
		dragControls,
		isDragPressed,
		isLongPressArmed,
		isReordering,
		handlers: {
			onDragStart: handleDragStart,
			onDragEnd: handleDragEnd,
			onClickCapture: handleClickCapture,
			onPointerDown: handleItemPointerDown,
			onPointerMove: handleItemPointerMove,
			onPointerUp: cancelLongPress,
			onPointerCancel: cancelLongPress,
			onContextMenu: handleContextMenu,
		},
	};
}
