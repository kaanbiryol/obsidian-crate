import { useEffect, useState } from 'react';

export const INITIAL_LOADING_MIN_DURATION_MS = 600;
export const INITIAL_LOADING_EXIT_DURATION_MS = 180;

interface InitialLoadingGate {
	canReveal: boolean;
	isLoadingVisible: boolean;
}

export function useInitialLoadingGate(ready: boolean): InitialLoadingGate {
	const [minimumDurationElapsed, setMinimumDurationElapsed] = useState(false);
	const [isLoadingVisible, setIsLoadingVisible] = useState(true);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			setMinimumDurationElapsed(true);
		}, INITIAL_LOADING_MIN_DURATION_MS);
		return () => window.clearTimeout(timer);
	}, []);

	const canReveal = ready && minimumDurationElapsed;

	useEffect(() => {
		if (!canReveal) return;
		const timer = window.setTimeout(() => {
			setIsLoadingVisible(false);
		}, INITIAL_LOADING_EXIT_DURATION_MS);
		return () => window.clearTimeout(timer);
	}, [canReveal]);

	return { canReveal, isLoadingVisible };
}
