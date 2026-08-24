import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEventHandler } from 'react';

const DISMISS_VELOCITY = 0.72;
const MIN_DISMISS_DISTANCE = 96;
const MAX_DISMISS_DISTANCE = 180;
const SNAP_DURATION_MS = 340;

export interface SheetDragHandleProps {
	onPointerCancel: PointerEventHandler<HTMLDivElement>;
	onPointerDown: PointerEventHandler<HTMLDivElement>;
	onPointerMove: PointerEventHandler<HTMLDivElement>;
	onPointerUp: PointerEventHandler<HTMLDivElement>;
}

interface SheetDragState {
	backdropStyle: CSSProperties;
	dragClassName: string;
	handleProps: SheetDragHandleProps;
}

export function useSheetDrag({
	disabled,
	onDismiss,
}: {
	disabled: boolean;
	onDismiss: () => void;
}): SheetDragState {
	const [dragY, setDragY] = useState(0);
	const [isDragging, setIsDragging] = useState(false);
	const [isSnapping, setIsSnapping] = useState(false);
	const pointerRef = useRef<{
		id: number;
		lastTime: number;
		lastY: number;
		startY: number;
		velocity: number;
	} | null>(null);
	const snapTimerRef = useRef<number | null>(null);
	const sheetHeightRef = useRef(0);

	const clearSnapTimer = useCallback(() => {
		if (snapTimerRef.current !== null) {
			window.clearTimeout(snapTimerRef.current);
			snapTimerRef.current = null;
		}
	}, []);

	useEffect(() => clearSnapTimer, [clearSnapTimer]);

	const snapBack = useCallback(() => {
		pointerRef.current = null;
		setIsDragging(false);
		setIsSnapping(true);
		setDragY(0);
		clearSnapTimer();
		snapTimerRef.current = window.setTimeout(() => {
			snapTimerRef.current = null;
			setIsSnapping(false);
		}, SNAP_DURATION_MS);
	}, [clearSnapTimer]);

	const handlePointerDown = useCallback<PointerEventHandler<HTMLDivElement>>((event) => {
		if (disabled || !event.isPrimary || event.button !== 0) return;
		clearSnapTimer();
		const sheet = event.currentTarget.closest<HTMLElement>('.pwa-reminder-editor, .pwa-picker-sheet, .settings-sheet');
		sheetHeightRef.current = sheet?.getBoundingClientRect().height ?? window.innerHeight;
		pointerRef.current = {
			id: event.pointerId,
			lastTime: event.timeStamp,
			lastY: event.clientY,
			startY: event.clientY,
			velocity: 0,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
		const activeElement = document.activeElement;
		if (activeElement instanceof HTMLElement && activeElement.matches('input, textarea, [contenteditable="true"]')) {
			activeElement.blur();
		}
		setIsSnapping(false);
		setIsDragging(true);
	}, [clearSnapTimer, disabled]);

	const handlePointerMove = useCallback<PointerEventHandler<HTMLDivElement>>((event) => {
		const pointer = pointerRef.current;
		if (!pointer || pointer.id !== event.pointerId) return;
		const nextY = Math.max(0, event.clientY - pointer.startY);
		const elapsed = Math.max(1, event.timeStamp - pointer.lastTime);
		pointer.velocity = (event.clientY - pointer.lastY) / elapsed;
		pointer.lastY = event.clientY;
		pointer.lastTime = event.timeStamp;
		setDragY(nextY);
	}, []);

	const finishDrag = useCallback<PointerEventHandler<HTMLDivElement>>((event) => {
		const pointer = pointerRef.current;
		if (!pointer || pointer.id !== event.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		const distance = Math.max(0, event.clientY - pointer.startY);
		const distanceThreshold = Math.min(
			MAX_DISMISS_DISTANCE,
			Math.max(MIN_DISMISS_DISTANCE, sheetHeightRef.current * 0.28),
		);
		pointerRef.current = null;
		setIsDragging(false);
		if (distance >= distanceThreshold || (distance >= 24 && pointer.velocity >= DISMISS_VELOCITY)) {
			onDismiss();
			return;
		}
		snapBack();
	}, [onDismiss, snapBack]);

	const handlePointerCancel = useCallback<PointerEventHandler<HTMLDivElement>>((event) => {
		if (pointerRef.current?.id !== event.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		snapBack();
	}, [snapBack]);

	const progress = Math.min(1, dragY / Math.max(1, sheetHeightRef.current * 0.72));
	return {
		backdropStyle: {
			'--pwa-sheet-drag-progress': progress,
			'--pwa-sheet-drag-y': `${Math.round(dragY)}px`,
		} as CSSProperties,
		dragClassName: `${isDragging ? ' is-dragging-sheet' : ''}${isSnapping ? ' is-snapping-sheet' : ''}`,
		handleProps: {
			onPointerCancel: handlePointerCancel,
			onPointerDown: handlePointerDown,
			onPointerMove: handlePointerMove,
			onPointerUp: finishDrag,
		},
	};
}
