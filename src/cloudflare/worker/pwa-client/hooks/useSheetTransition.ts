import { useCallback, useRef, useState } from 'react';

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

	return { isClosing, requestClose, cancelClose, finishClose };
}
