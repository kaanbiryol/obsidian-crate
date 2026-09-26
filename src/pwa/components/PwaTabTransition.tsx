import React, { useLayoutEffect, useRef } from 'react';
import { AnimatePresence, usePresence } from 'motion/react';

function TabPanel({ children, viewKey }: { children: React.ReactNode; viewKey: string }) {
	const [isPresent, safeToRemove] = usePresence();
	const panel = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (isPresent) return;
		// The feature shell already owns the dissolve when returning from Reading.
		if (panel.current?.closest('.crate-feature-panel')?.getAttribute('data-entering') === 'true') {
			safeToRemove?.();
			return;
		}
		// animationend owns normal cleanup; recover from a cancelled browser animation.
		const timeout = window.setTimeout(() => safeToRemove?.(), 1000);
		return () => window.clearTimeout(timeout);
	}, [isPresent, safeToRemove]);
	return <div ref={panel} className="pwa-tab-panel" data-tab-view={viewKey}
		data-leaving={!isPresent || undefined} inert={!isPresent} aria-hidden={!isPresent || undefined}
		onAnimationEnd={event => {
			if (event.target === event.currentTarget && event.animationName === 'crate-mode-fade-out' && !isPresent) safeToRemove?.();
		}}>{children}</div>;
}

/** Keep the outgoing screen painted over an opaque incoming screen, like FeatureShell. */
export function PwaTabTransition({ viewKey, children }: { viewKey: string; children: React.ReactNode }) {
	return <div className="pwa-tab-transition"><AnimatePresence initial={false}>
		<TabPanel key={viewKey} viewKey={viewKey}>{children}</TabPanel>
	</AnimatePresence></div>;
}
