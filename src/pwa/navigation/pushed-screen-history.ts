interface PageEntry<Page extends string> { owner: string; id: string; page: Page }
interface PageState<Page extends string> {
	cratePushedPage?: PageEntry<Page>;
	cratePushedPageBase?: string;
	pwaBackDestination?: string;
}

/** A sheet's pushed pages borrow the current entry as their root. Keep this
 * controller mounted with the app so browser Forward can reopen a closed sheet.
 * Owned traversals never reach the feature routers underneath that sheet. */
export function createPushedScreenHistory<Page extends string>(pages: readonly Page[]) {
	const owner = crypto.randomUUID();
	let snapshot: { page: Page | null; entryId: string | null; immediate: boolean; closing: boolean } = { page: null, entryId: null, immediate: false, closing: false };
	const listeners = new Set<() => void>();
	const publish = (next: typeof snapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
	const current = () => history.state as PageState<Page> | null;
	let activeId: string | null = null;
	let parentState: unknown = null;
	let traversing = false;
	let queuedPage: Page | null = null;
	const push = (page: Page) => {
		if (snapshot.closing) { queuedPage = page; return; }
		if (snapshot.page) return;
		parentState = history.state;
		activeId = crypto.randomUUID();
		const base = { ...current(), cratePushedPage: undefined, cratePushedPageBase: activeId };
		// Record the visible root before mounting its detail, for native Back previews.
		history.replaceState(base, '', location.href);
		history.pushState({ ...base, cratePushedPage: { owner, id: activeId, page }, pwaBackDestination: 'pushed-page' }, '', location.href);
		publish({ page, entryId: activeId, immediate: false, closing: false });
	};
	return {
		subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		getSnapshot: () => snapshot,
		install(onReveal: () => void) {
			const pop = (event: PopStateEvent) => {
				const state = current();
				const page = state?.cratePushedPage;
				if (page?.owner === owner && pages.includes(page.page)) {
					traversing = false;
					event.stopImmediatePropagation();
					activeId = page.id;
					publish({ page: page.page, entryId: activeId, immediate: true, closing: false });
					onReveal();
				} else if (activeId && state?.cratePushedPageBase === activeId) {
					traversing = false;
					event.stopImmediatePropagation();
					activeId = null;
					publish({ page: null, entryId: null, immediate: true, closing: false });
					const next = queuedPage; queuedPage = null;
					if (next) push(next);
				} else if (activeId) {
					activeId = null; queuedPage = null; traversing = false;
					publish({ page: null, entryId: null, immediate: true, closing: false });
				}
			};
			window.addEventListener('popstate', pop, { capture: true });
			return () => window.removeEventListener('popstate', pop, { capture: true });
		},
		push,
		back() {
			if (!snapshot.page || snapshot.closing) return;
			publish({ page: null, entryId: null, immediate: false, closing: true });
		},
		finishBack(this: void) {
			if (!snapshot.closing || traversing) return;
			// The screen has painted its root; the traversal should not animate it again.
			if (current()?.cratePushedPage?.owner === owner) { traversing = true; history.back(); }
			else publish({ page: null, entryId: null, immediate: true, closing: false });
		},
		reset() {
			// Logout/session loss can unmount the sheet directly from a pushed page.
			if (current()?.cratePushedPage?.owner === owner) history.replaceState(parentState, '', location.href);
			activeId = null;
			queuedPage = null;
			traversing = false;
			publish({ page: null, entryId: null, immediate: true, closing: false });
		},
	};
}

export type PushedScreenHistory<Page extends string> = ReturnType<typeof createPushedScreenHistory<Page>>;
