import { useEffect, useState } from 'react';

export const INITIAL_LOADING_MIN_DURATION_MS = 600;

export function useInitialLoadingGate(ready: boolean): boolean {
	const [minimumDurationElapsed, setMinimumDurationElapsed] = useState(false);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			setMinimumDurationElapsed(true);
		}, INITIAL_LOADING_MIN_DURATION_MS);
		return () => window.clearTimeout(timer);
	}, []);

	return ready && minimumDurationElapsed;
}
