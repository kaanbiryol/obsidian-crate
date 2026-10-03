import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';

interface TabContent {
	viewKey: string;
	children: React.ReactNode;
}

interface TabLayer extends TabContent { id: number; preparing: boolean }

/** Dissolve screens without changing their paint order when a switch reverses. */
export function TabTransition({ viewKey, children }: TabContent) {
	const container = useRef<HTMLDivElement>(null);
	const featureEntryPainted = useRef(false);
	const [{ layers, nextId }, setLayers] = useState<{ layers: TabLayer[]; nextId: number }>({
		layers: [{ viewKey, children, id: 0, preparing: false }], nextId: 1,
	});
	const selectedIndex = layers.findIndex(layer => layer.viewKey === viewKey);

	// New screens go underneath the painted stack. Keep the departing content
	// and DOM nodes until the dissolve settles, including across rapid reversals.
	if (selectedIndex === -1) {
		setLayers({ nextId: nextId + 1, layers: [{ viewKey, children, id: nextId, preparing: true }, ...layers] });
	} else if (layers[selectedIndex]?.children !== children) {
		setLayers({ nextId, layers: layers.map(layer => layer.viewKey === viewKey ? { ...layer, children } : layer) });
	}

	const discardDepartedLayers = useCallback(() => {
		setLayers(current => current.layers.length === 1 ? current : {
			...current, layers: current.layers.filter(layer => layer.viewKey === viewKey).map(layer => ({ ...layer, preparing: false })),
		});
	}, [viewKey]);

	const finishTransition = useCallback(() => {
		const panels = Array.from(container.current?.children ?? []) as HTMLElement[];
		if (panels.every(panel => (panel.ownerDocument.defaultView ?? window).getComputedStyle(panel).opacity === panel.style.opacity)) {
			discardDepartedLayers();
		}
	}, [discardDepartedLayers]);

	useLayoutEffect(() => {
		const panel = container.current?.closest('.crate-feature-panel, .plugin-workspace-panel');
		if (!panel) return;
		// A retained tab need not render when its feature leaves or finishes
		// entering. Reset the handoff guard even when only the shell updates.
		const owner = panel.ownerDocument.defaultView ?? window;
		const observer = new owner.MutationObserver(() => { featureEntryPainted.current = false; });
		observer.observe(panel, { attributes: true, attributeFilter: ['data-entering'] });
		return () => observer.disconnect();
	}, []);

	useLayoutEffect(() => {
		// The feature shell already owns the dissolve when returning from Reading.
		// Returning to the same tab must also discard an interrupted local fade;
		// its view key and cleanup callbacks have not changed in that case.
		const panel = container.current?.closest('.crate-feature-panel, .plugin-workspace-panel');
		const entering = panel?.getAttribute('data-entering') === 'true';
		if (!entering) { featureEntryPainted.current = false; return; }
		if (featureEntryPainted.current) return;
		discardDepartedLayers();
		// Only settle the initial handoff. Once it has painted, another tab tap
		// needs its own fade even if the outer feature dissolve is still running.
		const owner = container.current?.ownerDocument.defaultView ?? window;
		const frame = owner.requestAnimationFrame(() => { featureEntryPainted.current = panel?.getAttribute('data-entering') === 'true'; });
		return () => owner.cancelAnimationFrame(frame);
	});

	useLayoutEffect(() => {
		// Covers a reversal before the browser starts a transition. transitionend
		// owns normal cleanup; the timeout recovers if the browser cancels it.
		const owner = container.current?.ownerDocument.defaultView ?? window;
		const frame = owner.requestAnimationFrame(finishTransition);
		const timeout = owner.setTimeout(discardDepartedLayers, 1000);
		return () => { owner.cancelAnimationFrame(frame); owner.clearTimeout(timeout); };
	}, [discardDepartedLayers, finishTransition]);

	return <div ref={container} className="pwa-tab-transition">
		{/* Cleanup and reopening can share a commit. A new layer must not reuse
		    the removed view's transparent DOM node and its native transition. */}
		{layers.map((layer, index) => <div key={layer.id} className="pwa-tab-panel" data-tab-view={layer.viewKey}
			data-preparing={layer.preparing || undefined}
			data-leaving={layer.viewKey !== viewKey || undefined}
			inert={layer.viewKey !== viewKey} aria-hidden={layer.viewKey !== viewKey || undefined}
			style={{ zIndex: index + 1, opacity: index <= selectedIndex ? 1 : 0 }}
			onTransitionEnd={event => {
				if (event.target === event.currentTarget && event.propertyName === 'opacity') finishTransition();
			}}>{layer.children}</div>)}
	</div>;
}
