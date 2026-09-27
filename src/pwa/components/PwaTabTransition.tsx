import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';

interface TabContent {
	viewKey: string;
	children: React.ReactNode;
}

interface TabLayer extends TabContent { preparing: boolean }

/** Dissolve screens without changing their paint order when a switch reverses. */
export function PwaTabTransition({ viewKey, children }: TabContent) {
	const container = useRef<HTMLDivElement>(null);
	const [layers, setLayers] = useState<TabLayer[]>([{ viewKey, children, preparing: false }]);
	const selectedIndex = layers.findIndex(layer => layer.viewKey === viewKey);

	// New screens go underneath the painted stack. Keep the departing content
	// and DOM nodes until the dissolve settles, including across rapid reversals.
	if (selectedIndex === -1) {
		setLayers([{ viewKey, children, preparing: true }, ...layers]);
	} else if (layers[selectedIndex]?.children !== children) {
		setLayers(layers.map(layer => layer.viewKey === viewKey ? { ...layer, children } : layer));
	}

	const discardDepartedLayers = useCallback(() => {
		setLayers(current => current.length === 1 ? current
			: current.filter(layer => layer.viewKey === viewKey).map(layer => ({ ...layer, preparing: false })));
	}, [viewKey]);

	const finishTransition = useCallback(() => {
		const panels = Array.from(container.current?.children ?? []) as HTMLElement[];
		if (panels.every(panel => getComputedStyle(panel).opacity === panel.style.opacity)) {
			discardDepartedLayers();
		}
	}, [discardDepartedLayers]);

	useLayoutEffect(() => {
		// The feature shell already owns the dissolve when returning from Reading.
		if (container.current?.closest('.crate-feature-panel')?.getAttribute('data-entering') === 'true') {
			discardDepartedLayers();
			return;
		}
		// Covers a reversal before the browser starts a transition. transitionend
		// owns normal cleanup; the timeout recovers if the browser cancels it.
		const frame = requestAnimationFrame(finishTransition);
		const timeout = window.setTimeout(discardDepartedLayers, 1000);
		return () => { cancelAnimationFrame(frame); window.clearTimeout(timeout); };
	}, [discardDepartedLayers, finishTransition]);

	return <div ref={container} className="pwa-tab-transition">
		{layers.map((layer, index) => <div key={layer.viewKey} className="pwa-tab-panel" data-tab-view={layer.viewKey}
			data-preparing={layer.preparing || undefined}
			data-leaving={layer.viewKey !== viewKey || undefined}
			inert={layer.viewKey !== viewKey} aria-hidden={layer.viewKey !== viewKey || undefined}
			style={{ zIndex: index + 1, opacity: index <= selectedIndex ? 1 : 0 }}
			onTransitionEnd={event => {
				if (event.target === event.currentTarget && event.propertyName === 'opacity') finishTransition();
			}}>{layer.children}</div>)}
	</div>;
}
