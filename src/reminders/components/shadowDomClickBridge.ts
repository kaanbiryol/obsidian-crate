import { useCallback, useEffect, useRef } from 'react';
import type React from 'react';

function assignRef<T>(ref: React.ForwardedRef<T>, value: T | null): void {
	if (typeof ref === 'function') {
		ref(value);
		return;
	}
	if (ref) ref.current = value;
}

export function useShadowDomClickBridge<T extends HTMLElement>(
	onClick: () => void,
	forwardedRef: React.ForwardedRef<T>,
): React.RefCallback<T> {
	const elementRef = useRef<T>(null);
	const onClickRef = useRef(onClick);
	onClickRef.current = onClick;

	const combinedRef = useCallback((node: T | null) => {
		elementRef.current = node;
		assignRef(forwardedRef, node);
	}, [forwardedRef]);

	useEffect(() => {
		const element = elementRef.current;
		if (!element) return;
		const handleClick = (event: MouseEvent) => {
			event.stopPropagation();
			onClickRef.current();
		};
		element.addEventListener('click', handleClick, true);
		return () => element.removeEventListener('click', handleClick, true);
	}, [combinedRef]);

	return combinedRef;
}
