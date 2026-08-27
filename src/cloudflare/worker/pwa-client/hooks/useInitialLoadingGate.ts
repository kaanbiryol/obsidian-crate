import { useEffect, useState } from 'react';

export const INITIAL_LOADING_MIN_DURATION_MS = 600;
export const INITIAL_LOADING_EXIT_DURATION_MS = 180;
export const INITIAL_LOADING_MAX_DURATION_MS = 8_000;

interface InitialLoadingGate {
	canReveal: boolean;
	isLoadingVisible: boolean;
}

export function useInitialLoadingGate(ready: boolean): InitialLoadingGate {
	const [minimumDurationElapsed, setMinimumDurationElapsed] = useState(false);
	const [maximumDurationElapsed, setMaximumDurationElapsed] = useState(false);
	const [isLoadingVisible, setIsLoadingVisible] = useState(true);

	useEffect(() => {
		const minimumTimer = window.setTimeout(() => {
			setMinimumDurationElapsed(true);
		}, INITIAL_LOADING_MIN_DURATION_MS);
		const maximumTimer = window.setTimeout(() => {
			setMaximumDurationElapsed(true);
		}, INITIAL_LOADING_MAX_DURATION_MS);
		return () => {
			window.clearTimeout(minimumTimer);
			window.clearTimeout(maximumTimer);
		};
	}, []);

	const canReveal = (ready && minimumDurationElapsed) || maximumDurationElapsed;

	useEffect(() => {
		if (!canReveal) return;
		const timer = window.setTimeout(() => {
			setIsLoadingVisible(false);
		}, INITIAL_LOADING_EXIT_DURATION_MS);
		return () => window.clearTimeout(timer);
	}, [canReveal]);

	return { canReveal, isLoadingVisible };
}
