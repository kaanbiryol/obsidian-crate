// Features share one browser history. Only a stack created in this document has
// a known same-document predecessor; saved state alone is not enough after reload.
let documentStackId: string | null = null;
let cancelOpening: (() => void) | null = null;
let pendingBack: ((event: PopStateEvent) => void) | null = null;

/** Install before feature routers so an internal traversal cannot close a screen. */
export function installDetailHistory(): () => void {
	const back = (event: PopStateEvent) => pendingBack?.(event);
	window.addEventListener('popstate', back, { capture: true });
	return () => window.removeEventListener('popstate', back, { capture: true });
}

/** A feature switch wins over an in-flight internal traversal. Call after routing. */
export function cancelDetailHistoryOpen(): void {
	cancelOpening?.();
}

type Entry = Record<string, unknown>;
interface DetailHistory {
	stackKey: string;
	detailKey: string;
	closedKey: string;
	parameter: string;
}

/** Keep feature URL/state adapters small and the snapshot lifecycle shared. */
export function createDetailHistory(config: DetailHistory) {
	const entry = () => history.state as Entry | null;
	const hasDetail = () => Boolean(entry()?.[config.detailKey]);
	const open = async (detail: URL, value: unknown, destination: Entry = {}, list = new URL(detail)): Promise<string | null> => {
		if (cancelOpening) return null;
		const previous = entry();
		const reusable = typeof previous?.[config.stackKey] === 'string' && previous[config.stackKey] === documentStackId;
		if (reusable && hasDetail()) {
			// Resolving an already-open detail (for example a saved Reading link)
			// must retain the original list destination.
			history.replaceState({ ...previous, [config.detailKey]: value, pwaBackDestination: config.detailKey }, '', detail);
			return documentStackId;
		}
		const stackId = reusable ? documentStackId! : crypto.randomUUID();
		list.searchParams.delete(config.parameter);
		const base = { ...destination, [config.stackKey]: stackId };
		const push = () => {
			documentStackId = stackId;
			history.replaceState(base, '', list);
			history.pushState({ ...base, [config.detailKey]: value, pwaBackDestination: config.detailKey }, '', detail);
			return stackId;
		};
		if (!reusable || !previous?.[config.closedKey]) return push();

		// replaceState on a closed detail slot leaves its predecessor's captured
		// pixels unchanged. Revisit that predecessor WITHOUT changing the live
		// list, then push from it again. This refreshes every visual dependency
		// (theme, data, filters, scroll, dock), and replaces rather than grows the
		// forward slot. No theme/data-specific invalidation list is required.
		let cancelled: { state: unknown; url: string } | null = null;
		cancelOpening = () => { cancelled = { state: history.state, url: location.href }; };
		return new Promise((resolve, reject) => {
			const back = (event: PopStateEvent) => {
				pendingBack = null;
				cancelOpening = null;
				if (cancelled) {
					event.stopImmediatePropagation();
					documentStackId = null;
					history.replaceState(cancelled.state, '', cancelled.url);
					resolve(null);
					return;
				}
				if (entry()?.[config.stackKey] !== stackId || hasDetail() || entry()?.[config.closedKey]) {
					documentStackId = null;
					resolve(null); // An unrelated traversal belongs to the normal router.
					return;
				}
				event.stopImmediatePropagation();
				try { resolve(push()); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
			};
			pendingBack = back;
			try { history.back(); } catch (error) {
				pendingBack = null;
				cancelOpening = null;
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};
	const dismiss = (stackId: string | null) => {
		const current = entry();
		if (!stackId || current?.[config.stackKey] !== stackId || hasDetail() || current?.[config.closedKey]
			|| new URL(location.href).searchParams.has(config.parameter)) return;
		// Call only after the destination has painted. Truncate Forward so a
		// native forward gesture cannot preview or reopen the dismissed detail.
		history.pushState({ ...current, [config.closedKey]: true }, '', location.href);
	};
	return { open, dismiss, hasDetail };
}
