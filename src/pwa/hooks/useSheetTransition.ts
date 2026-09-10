import { useCallback, useEffect, useRef, useState } from 'react';

export function useSheetTransition(onClosed: () => void): {
	isClosing: boolean;
	requestClose: () => void;
	cancelClose: () => void;
	finishClose: () => void;
} {
	const [isClosing, setIsClosing] = useState(false);
	const closingRef = useRef(false);

	const cancelClose = useCallback(() => {
		closingRef.current = false;
		setIsClosing(false);
	}, []);

	const requestClose = useCallback(() => {
		if (closingRef.current) return;
		closingRef.current = true;
		setIsClosing(true);
	}, []);

	const finishClose = useCallback(() => {
		if (!closingRef.current) return;
		closingRef.current = false;
		setIsClosing(false);
		onClosed();
	}, [onClosed]);

	useEffect(() => {
		if (!isClosing) return;
		// The normal exit takes 260ms. If its completion callback is lost,
		// unmount the closed sheet so its backdrop and background lock cannot linger.
		const timeout = window.setTimeout(finishClose, 1000);
		return () => window.clearTimeout(timeout);
	}, [isClosing, finishClose]);

	return { isClosing, requestClose, cancelClose, finishClose };
}
