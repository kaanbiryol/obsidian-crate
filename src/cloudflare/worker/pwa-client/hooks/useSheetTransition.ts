import { useCallback, useEffect, useRef, useState } from 'react';

export const PWA_SHEET_EXIT_MS = 300;

export function useSheetTransition(onClosed: () => void): {
	isClosing: boolean;
	requestClose: () => void;
	cancelClose: () => void;
} {
	const [isClosing, setIsClosing] = useState(false);
	const closeTimerRef = useRef<number | null>(null);

	const cancelClose = useCallback(() => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
		setIsClosing(false);
	}, []);

	const requestClose = useCallback(() => {
		if (closeTimerRef.current !== null) return;
		setIsClosing(true);
		const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			setIsClosing(false);
			onClosed();
		}, reduceMotion ? 0 : PWA_SHEET_EXIT_MS);
	}, [onClosed]);

	useEffect(() => () => {
		if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
	}, []);

	return { isClosing, requestClose, cancelClose };
}
