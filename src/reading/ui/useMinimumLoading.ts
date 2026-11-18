import { useLayoutEffect, useState } from 'react';

interface ShownLoading { since: number; appearDelayMs: number }

/** `loading`, kept on so a spinner that became visible stays at least `minimumMs`. Its
 * spinner appears `appearDelayMs` after the loading state does; a loading state that ends
 * before then showed no spinner and ends at once. The delay a loading state starts with is
 * kept until it ends, so its spinner never restarts. */
export function useMinimumLoading(loading: boolean, appearDelayMs: number, minimumMs: number) {
	const [shown, setShown] = useState<ShownLoading | null>(null);
	useLayoutEffect(() => {
		if (loading) {
			if (!shown) setShown({ since: Date.now(), appearDelayMs });
			return;
		}
		if (!shown) return;
		const visible = shown.since + shown.appearDelayMs, now = Date.now();
		if (now < visible || now >= visible + minimumMs) { setShown(null); return; }
		const timer = window.setTimeout(() => setShown(null), visible + minimumMs - now);
		return () => window.clearTimeout(timer);
	}, [loading, shown, appearDelayMs, minimumMs]);
	return { loading: loading || shown !== null, appearDelayMs: shown?.appearDelayMs ?? appearDelayMs };
}
