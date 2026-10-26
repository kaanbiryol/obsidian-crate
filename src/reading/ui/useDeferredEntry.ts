import { useEffect, useState, type RefObject } from 'react';

/** Whether the reader pane has finished sliding in for `itemId`. Hosts that defer
 * the article keep parsing and layout out of that opening transition. */
export function useDeferredEntry(article: RefObject<HTMLElement | null>, deferred: boolean, itemId: string): boolean {
	const [enteredId, setEnteredId] = useState<string | null>(null);
	useEffect(() => {
		if (!deferred) return;
		let cancelled = false;
		// Reading the pane's animations flushes its new style, including the first
		// opening transition. Cached/network text can arrive while it is moving.
		const animations = article.current?.closest('.crate-reading__reader-pane')?.getAnimations()
			.filter(animation => 'transitionProperty' in animation && animation.transitionProperty === 'transform') ?? [];
		void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
			if (!cancelled) setEnteredId(itemId);
		});
		return () => { cancelled = true; };
	}, [article, deferred, itemId]);
	return !deferred || enteredId === itemId;
}
